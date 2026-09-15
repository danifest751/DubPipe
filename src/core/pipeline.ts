import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { DubConfig } from '../config/schema.js';
import { LONG_INPUT_SECONDS, runS1 } from '../stages/s1-input.js';
import { runS2 } from '../stages/s2-asr.js';
import { runS3 } from '../stages/s3-translate.js';
import { runS4 } from '../stages/s4-separate.js';
import { runS5 } from '../stages/s5-tts.js';
import { runS6 } from '../stages/s6-align.js';
import { resolveOutputPath, runS7 } from '../stages/s7-mix.js';
import { subtitleOptionsFrom, writeSubtitleFiles, type SubtitleResult } from '../stages/subtitles.js';
import { sha256 } from '../util/hash.js';
import { StageError } from './errors.js';
import { cancellation, CancelledError } from './cancel.js';
import { counter, formatDuration, log } from './logger.js';
import { MANDATORY_STAGES, STAGE_IDS, STAGE_TITLES, type Segment, type StageId, type StageOutcome } from './types.js';
import { computeFingerprints, Workspace } from './workspace.js';
import { EMPTY_OVERRIDES, type ProjectOverrides } from './overrides.js';

/**
 * Stage orchestration with resumable caching (SPEC §2, §7).
 * A stage is skipped when its fingerprint matches the recorded one and its
 * artifacts are still on disk; the fingerprint chain means touching an early
 * stage invalidates every later one.
 */

export interface PipelineOptions {
  input: string;
  config: DubConfig;
  out?: string;
  /** Папка для итога; имя файла строится из имени входа. */
  outDir?: string;
  /** Писать субтитры (два файла SRT) после стадии перевода. */
  subtitles?: boolean;
  fromStage?: StageId;
  toStage?: StageId;
  /**
   * Спросить перед долгой работой. Вызывается не более одного раза и только на
   * входах длиннее `LONG_INPUT_SECONDS`; «нет» останавливает прогон до того,
   * как он потратит часы и деньги. Интерфейс длительность показывает и так,
   * поэтому спрашивает только консоль.
   */
  confirm?: (info: { durationSeconds: number; input: string }) => Promise<boolean>;
}

export interface PipelineReport {
  workspace: string;
  outcomes: StageOutcome[];
  warnings: string[];
  output: string | null;
  segments: Segment[];
  /** Записанные файлы субтитров (когда запрошены). */
  subtitles: SubtitleResult['files'];
}

/** Stages disabled by config, with the mandatory ones protected (SPEC §2). */
export function disabledStages(config: DubConfig): Set<StageId> {
  const disabled = new Set<StageId>();
  if (!config.separation.enabled) disabled.add('s4');
  if (!config.alignment.enabled) disabled.add('s6');
  for (const stage of MANDATORY_STAGES) disabled.delete(stage);
  return disabled;
}

/**
 * Спикеры нужны только озвучке: по ним раздаются голоса на S5. Если прогон до
 * неё не доходит (субтитры, распознавание, перевод), диаризация — это минуты
 * работы впустую: на 12-минутном эпизоде 4.5 из 5.8 минут стадии S2.
 */
export function needsSpeakers(stages: StageId[]): boolean {
  return stages.includes('s5');
}

/**
 * Конфигурация, действующая в этом прогоне. Диаризация выключается, когда
 * озвучки не будет; отпечаток S2 считается уже по ней, поэтому запуск с
 * озвучкой не возьмёт из кэша распознавание без спикеров.
 */
export function effectiveConfig(config: DubConfig, stages: StageId[]): DubConfig {
  if (!config.asr.diarization.enabled || needsSpeakers(stages)) return config;
  return {
    ...config,
    asr: { ...config.asr, diarization: { ...config.asr.diarization, enabled: false } },
  };
}

export function stageRange(from: StageId = 's1', to: StageId = 's7'): StageId[] {
  const start = STAGE_IDS.indexOf(from);
  const end = STAGE_IDS.indexOf(to);
  if (start > end) {
    throw new StageError(from, `--from-stage ${from} идёт после --to-stage ${to}`);
  }
  return STAGE_IDS.slice(start, end + 1);
}

/**
 * Отработала ли стадия, судя по репликам.
 *
 * Требовать файл от каждой реплики нельзя: перевод одной реплики может
 * сорваться, и тогда у неё нет ни русского текста, ни синтеза, ни подгонки —
 * это штатный исход, а не незаконченная стадия. Одно непереведённое «а-а»
 * иначе закрывает продолжение прогона с середины и заставляет переводить
 * заново все триста реплик.
 *
 * Поэтому стадия считается сделанной, когда её работа есть у тех реплик,
 * которым она вообще полагалась, и хотя бы у одной реплики она есть.
 */
export function stageComplete(
  stage: 's3' | 's5' | 's6',
  segments: Segment[],
  exists: (file: string) => boolean = existsSync,
): boolean {
  switch (stage) {
    case 's3':
      return segments.some((segment) => segment.text_ru !== null);
    case 's5':
      return (
        segments.some((segment) => segment.tts_file !== null) &&
        segments.every((segment) => !segment.text_ru || (segment.tts_file !== null && exists(segment.tts_file)))
      );
    case 's6':
      return (
        segments.some((segment) => segment.aligned_file !== null) &&
        segments.every(
          (segment) => !segment.tts_file || (segment.aligned_file !== null && exists(segment.aligned_file)),
        )
      );
  }
}

async function artifactsPresent(stage: StageId, workspace: Workspace): Promise<boolean> {
  switch (stage) {
    case 's1':
      return existsSync(workspace.metaPath) && existsSync(workspace.file('audio.wav'));
    case 's2':
      return existsSync(workspace.segmentsPath);
    case 's4':
      return existsSync(workspace.file('background.wav'));
    case 's3':
    case 's5':
    case 's6': {
      const segments = await workspace.readSegments();
      return segments !== null && stageComplete(stage, segments);
    }
    case 's7':
      // The final file lives outside the workspace, so freshness is decided by
      // the fingerprint alone; re-muxing is cheap compared to losing the output.
      return false;
    default:
      return false;
  }
}

/**
 * Отпечаток того, из чего стадия делает свою работу.
 *
 * Отпечаток настроек не ловит случай, когда изменились сами реплики: перевод
 * переписали другой моделью, настройки те же — и синтез считается свежим, хотя
 * озвучен прежний текст. Так и вышло: субтитры обновились, а звук остался от
 * старого перевода, и заметить это можно было только на слух.
 *
 * Поэтому у стадий, работающих не с настройками, а с результатом предыдущих,
 * свежесть проверяется ещё и по содержимому: синтез — по переводу, укладка —
 * по тому, что синтезировано.
 */
export function stageInputHash(
  stage: StageId,
  segments: Segment[],
  overrides: ProjectOverrides = EMPTY_OVERRIDES,
): string | null {
  switch (stage) {
    case 's5':
      /*
       * Голоса из правок видео входят сюда наравне с текстом.
       *
       * Они накладываются внутри самой стадии, а отпечаток считается по общим
       * настройкам — поэтому правка `overrides.json` руками не меняла ничего:
       * отпечаток тот же, реплики те же, стадия пропущена, голос остался
       * прежним. Через интерфейс это работало лишь потому, что `planReview`
       * заодно снимает с реплик подпись клипа.
       *
       * Стадии сведения такая же строка не нужна: она из кэша не берётся
       * никогда, и громкости из правок применяются на каждом прогоне.
       */
      return sha256(JSON.stringify([segments.map((segment) => [segment.id, segment.text_ru]), overrides.voices]));
    case 's6':
      return sha256(JSON.stringify(segments.map((segment) => [segment.id, segment.tts_file, segment.tts_duration])));
    default:
      return null;
  }
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineReport> {
  const { input } = options;

  // План прогона нужен раньше отпечатков: от него зависит, выполнять ли
  // диаризацию, а она входит в отпечаток стадии распознавания.
  const planned = stageRange(options.fromStage, options.toStage);
  const skipped = disabledStages(options.config);
  const active = planned.filter((stage) => !skipped.has(stage));
  const config = effectiveConfig(options.config, active);
  const diarizationDropped = options.config.asr.diarization.enabled && !config.asr.diarization.enabled;

  const workspace = await Workspace.open(input, config);
  const fingerprints = computeFingerprints(config, workspace.inputHash);
  const state = await workspace.readState();

  // Спрашиваем один раз и в одном месте: длительность приходит либо из свежей
  // стадии S1, либо из meta.json прошлого прогона, если S1 взялась из кэша.
  let confirmationPending = options.confirm !== undefined;
  const confirmLongInput = async (durationSeconds: number): Promise<void> => {
    if (!confirmationPending || durationSeconds <= LONG_INPUT_SECONDS) return;
    confirmationPending = false;
    if (!(await options.confirm!({ durationSeconds, input }))) {
      throw new CancelledError('Отменено: длинный вход не подтверждён');
    }
  };

  // Журнал прогона на диске: поток событий интерфейса живёт только в памяти,
  // а разбирать проблемы на реальном материале без файла невозможно.
  const logFile = workspace.file('run.log');
  appendFileSync(logFile, `\n===== ${new Date().toISOString()} ${input}\n`);
  const unsubscribe = log.subscribe((record) => {
    appendFileSync(logFile, `${record.at.slice(11, 19)} ${record.level.padEnd(5)} ${record.text}\n`);
  });

  // Ctrl+C в консоли — та же остановка, что и кнопка в интерфейсе: дочерние
  // процессы убиваются, незавершённая стадия не записывает отпечаток.
  const onSigint = () => cancellation.abort();
  process.once('SIGINT', onSigint);

  try {

  if (diarizationDropped) {
    log.info('Диаризация пропущена: в этом прогоне нет озвучки, спикеры не понадобятся');
  }

  const outcomes: StageOutcome[] = [];
  const warnings: string[] = [];
  const overrides = await workspace.readOverrides();
  const knownMeta = await workspace.readMeta();
  if (knownMeta) await confirmLongInput(knownMeta.duration_seconds);
  let segments: Segment[] = (await workspace.readSegments()) ?? [];
  let analysisAudio = workspace.file('audio.wav');
  let output: string | null = null;

  // Starting mid-pipeline requires the earlier artifacts to exist (SPEC §6).
  if (options.fromStage && options.fromStage !== 's1') {
    const previous = STAGE_IDS.slice(0, STAGE_IDS.indexOf(options.fromStage));
    for (const stage of previous) {
      if (skipped.has(stage)) continue;
      if (!(await artifactsPresent(stage, workspace))) {
        throw new StageError(options.fromStage, `нет артефактов стадии ${stage} для запуска с ${options.fromStage}`, {
          hints: [`Выполните сначала: dub process "${input}" --to-stage ${stage}`],
        });
      }
    }
  }

  for (const [index, stage] of active.entries()) {
    cancellation.throwIfCancelled();
    log.stage(index + 1, active.length, stage, STAGE_TITLES[stage]);
    const started = Date.now();
    const fingerprint = fingerprints[stage];
    // Кроме настроек стадии сверяется и то, из чего она работает: перевод для
    // синтеза, синтез для укладки. Иначе повторный перевод не заставит
    // переозвучить реплики, и звук разойдётся с текстом.
    const inputHash = stageInputHash(stage, (await workspace.readSegments()) ?? segments, overrides);
    /*
     * Явно названная стадия отменяет кэш и для себя, и для всего, что после неё.
     *
     * Раньше отменялась только она сама, а следующие по-прежнему смотрели в кэш —
     * и пропускались, потому что их отпечаток не менялся. «Начать со стадии s1»
     * перечитывало видео и не трогало ничего дальше: шесть стадий из семи
     * рапортовали «кэш актуален», хотя человек просил пройти заново. Сходилось
     * лишь там, где стадия меняла segments.json и тем сдвигала отпечаток входа
     * у следующей, — то есть случайно.
     */
    const forced =
      options.fromStage !== undefined &&
      STAGE_IDS.indexOf(stage) >= STAGE_IDS.indexOf(options.fromStage);
    const fresh =
      config.cache.enabled &&
      !forced &&
      state.fingerprints[stage] === fingerprint &&
      (inputHash === null || state.segmentsHash[stage] === inputHash) &&
      (await artifactsPresent(stage, workspace));

    if (fresh) {
      log.step('кэш актуален — стадия пропущена');
      outcomes.push({ stage, cached: true, provider: 'кэш', warnings: [], durationMs: 0 });
      continue;
    }

    let provider = '—';
    const stageWarnings: string[] = [];

    switch (stage) {
      case 's1': {
        const result = await runS1(workspace, input);
        await confirmLongInput(result.meta.duration_seconds);
        analysisAudio = result.analysisAudio;
        provider = 'ffmpeg';
        stageWarnings.push(...result.warnings);
        break;
      }
      case 's2': {
        const result = await runS2(workspace, config, analysisAudio);
        segments = result.segments;
        provider = result.provider;
        stageWarnings.push(...result.warnings);
        state.segmentsHash['s2'] = sha256(await readFile(workspace.segmentsPath));
        break;
      }
      case 's3': {
        // Re-read from disk: segments.json may have been edited by hand between
        // stages, which is a supported workflow (SPEC §6).
        const current = (await workspace.readSegments()) ?? segments;
        const result = await runS3(workspace, config, current);
        segments = result.segments;
        provider = result.provider;
        stageWarnings.push(...result.warnings);
        state.segmentsHash['s3'] = sha256(await readFile(workspace.segmentsPath));
        break;
      }
      case 's4': {
        const result = await runS4(workspace, config);
        provider = result.provider;
        stageWarnings.push(...result.warnings);
        break;
      }
      case 's5': {
        const current = (await workspace.readSegments()) ?? segments;
        const result = await runS5(workspace, config, current);
        segments = result.segments;
        provider = result.provider;
        stageWarnings.push(...result.warnings);
        break;
      }
      case 's6': {
        const current = (await workspace.readSegments()) ?? segments;
        const result = await runS6(workspace, config, current);
        segments = result.segments;
        provider = result.provider;
        stageWarnings.push(...result.warnings);
        break;
      }
      case 's7': {
        const current = (await workspace.readSegments()) ?? segments;
        const meta = await workspace.readMeta();
        if (!meta) {
          throw new StageError('s7', 'нет meta.json — стадия s1 не выполнялась', {
            hints: [`Выполните: dub process "${input}" --from-stage s1`],
          });
        }
        const result = await runS7(workspace, config, current, meta, options.out, options.outDir);
        output = result.outputPath;
        meta.output = result.outputPath;
        await workspace.writeMeta(meta);
        provider = 'ffmpeg';
        stageWarnings.push(...result.warnings);
        break;
      }
      default:
        throw new StageError(stage, `стадия ${stage} ещё не реализована (этап ${milestoneOf(stage)})`, {
          hints: [`Ограничьте запуск: dub process "${input}" --to-stage s3`],
        });
    }

    state.fingerprints[stage] = fingerprint;
    // Запоминается то, с чем стадия начинала: укладка сама переписывает
    // длительности, и пересчёт после неё не совпал бы с входом никогда.
    if (inputHash !== null) state.segmentsHash[stage] = inputHash;
    await workspace.writeState(state);

    const durationMs = Date.now() - started;
    outcomes.push({ stage, cached: false, provider, warnings: stageWarnings, durationMs });
    warnings.push(...stageWarnings.map((w) => `[${stage}] ${w}`));
    log.step(`готово за ${formatDuration(durationMs)} (${counter(index + 1, active.length)})`);
  }

  const meta = await workspace.readMeta();
  if (meta) {
    meta.stage_fingerprints = { ...meta.stage_fingerprints };
    for (const stage of active) meta.stage_fingerprints[stage] = fingerprints[stage];
    await workspace.writeMeta(meta);
  }

  // Субтитры — не стадия конвейера, а его выход: файлы собираются из тех же
  // реплик и кладутся туда же, куда лёг бы дубляж.
  let subtitleFiles: SubtitleResult['files'] = [];
  if (options.subtitles) {
    const current = (await workspace.readSegments()) ?? segments;
    const targetDir =
      options.outDir ??
      path.dirname(
        resolveOutputPath({
          input,
          extension: meta?.has_video === false ? '.m4a' : '.mp4',
          outputOverride: options.out,
          configured: config.output,
        }),
      );
    const result = await writeSubtitleFiles(current, input, targetDir, subtitleOptionsFrom(config), config.asr.language);
    subtitleFiles = result.files;
    warnings.push(...result.warnings.map((warning) => `[субтитры] ${warning}`));
    if (meta) {
      meta.subtitles = result.files.map((file) => ({ lang: file.lang, kind: file.kind, path: file.path }));
      await workspace.writeMeta(meta);
    }
  }

  return { workspace: workspace.dir, outcomes, warnings, output, segments, subtitles: subtitleFiles };
  } finally {
    process.off('SIGINT', onSigint);
    unsubscribe();
  }
}

function milestoneOf(stage: StageId): string {
  switch (stage) {
    case 's3':
      return 'M2';
    case 's4':
      return 'M4';
    case 's5':
    case 's7':
      return 'M3';
    case 's6':
      return 'M5';
    default:
      return 'M1';
  }
}
