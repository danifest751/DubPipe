import path from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import type { DubConfig } from '../config/schema.js';
import { StageError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { warn, type Meta, type Segment, type StageWarning } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import { applyOverrides } from '../core/overrides.js';
import { run } from '../util/exec.js';
import { requireTool } from '../util/tools.js';
import { readWavFormat } from '../util/wav.js';
import { buildDuckEnvelope, buildSpeechPresenceEnvelope, buildVoiceTrack, type SpeechWindow, type TrackClip } from '../util/pcm.js';

/**
 * S7 — mixing and muxing (SPEC FR-7).
 *
 * Final track = background + synthesised replicas at their timecodes. The
 * background is `background.wav` when S4 ran, otherwise the original ducked
 * inside speech windows. Video is copied, never re-encoded.
 */

export interface S7Result {
  outputPath: string;
  warnings: StageWarning[];
}

interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** First pass of EBU R128 normalisation: measure (SPEC FR-7, revised). */
async function measureLoudness(ffmpeg: string, input: string, targetLufs: number): Promise<LoudnormMeasurement | null> {
  try {
    const { stderr } = await run(
      ffmpeg,
      [
        '-hide_banner', '-nostats', '-i', input,
        '-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`,
        '-f', 'null', '-',
      ],
      { timeoutMs: 3_600_000, captureStdout: false },
    );
    const start = stderr.lastIndexOf('{');
    const end = stderr.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return JSON.parse(stderr.slice(start, end + 1)) as LoudnormMeasurement;
  } catch (error) {
    log.debug(`измерение громкости не удалось: ${(error as Error).message}`);
    return null;
  }
}

/** Speech windows for ducking: VAD output when available, replica slots otherwise. */
export function speechWindows(segments: Segment[], vadWindows: SpeechWindow[] | null): SpeechWindow[] {
  if (vadWindows && vadWindows.length > 0) return vadWindows;
  return segments.map((segment) => ({ start: segment.start, end: segment.end }));
}

/**
 * Как поступить с оригинальной дорожкой под русской речью.
 *
 * `duck` — приглушить её целиком: просто и надёжно, но вместе с чужим голосом
 * приседает и музыка.
 * `subtract` — вычесть из оригинала выделенный голос, и только там, где мы
 * говорим. Музыка остаётся в полной громкости, а между репликами оригинал
 * вообще не тронут: песни сохраняют вокал.
 * `separated` — заменить оригинал пересобранным фоном целиком. Убирает исходный
 * голос везде, но и песни лишаются вокала.
 */
export type MixMode = 'duck' | 'subtract' | 'separated';

/**
 * Граф фильтров сведения. Отделён от запуска ffmpeg, чтобы его можно было
 * проверить тестами: ошибка в номере входа стоит дорого, а видна не сразу.
 *
 * Порядок входов задан режимом:
 * `duck` — оригинал, речь, огибающая приглушения;
 * `subtract` — оригинал, речь, выделенный голос, огибающая присутствия речи;
 * `separated` — пересобранный фон, речь.
 */
export function mixFilters(mode: MixMode, backgroundGainDb: number, voiceGainDb: number): string[] {
  const filters: string[] = [];
  let background = '[0:a]';

  if (mode === 'duck') {
    filters.push('[0:a][2:a]amultiply[ducked]');
    background = '[ducked]';
  } else if (mode === 'subtract') {
    // Вычитание в ffmpeg делается инверсией фазы и суммированием: проверено на
    // тоне, сигнал минус он же даёт ровно ноль. Через `amix=weights=1 -1` не
    // работает — там веса нормируются, и остаётся половина сигнала.
    filters.push('[2:a][3:a]amultiply[removable]');
    filters.push('[removable]volume=-1[inverted]');
    filters.push('[0:a][inverted]amix=inputs=2:duration=first:normalize=0[clean]');
    background = '[clean]';
  }

  filters.push(`${background}volume=${backgroundGainDb}dB[bg]`);
  filters.push(`[1:a]volume=${voiceGainDb}dB,aformat=channel_layouts=stereo[voice]`);
  filters.push('[bg][voice]amix=inputs=2:duration=first:normalize=0[mixed]');
  return filters;
}

/**
 * Где в итоговой дорожке звучит наша речь.
 *
 * Не то же самое, что речевые окна детектора: те показывают, где говорят **в
 * оригинале**, и по ним приглушают. Убирать же исходный голос нужно строго там,
 * где поверх него ложится русский, — иначе из песни, которую мы не дублируем,
 * пропал бы вокал.
 */
export function spokenWindows(segments: Segment[]): SpeechWindow[] {
  // Звучит ровно тот клип, который ляжет в дорожку: уложенный, если укладка
  // была, иначе сырой синтез. Спрашивать длительность надо у него же.
  return segments
    .map((segment) => ({
      segment,
      clip: segment.aligned_file ?? segment.tts_file,
      duration: segment.aligned_file !== null ? segment.aligned_duration : segment.tts_duration,
    }))
    .filter((entry) => entry.clip !== null && (entry.duration ?? 0) > 0)
    .map((entry) => {
      const start = entry.segment.start + (entry.segment.shift_ms ?? 0) / 1000;
      return { start, end: start + entry.duration! };
    })
    .sort((a, b) => a.start - b.start);
}

/**
 * Черновые дорожки сведения после мультиплексирования.
 *
 * Все четыре рождаются внутри этой же стадии и больше никем не читаются: звук
 * уже лежит в итоговом файле. Удалять их безопасно именно потому, что S7 не
 * кэшируется никогда (см. artifactsPresent) и соберёт их заново при следующем
 * прогоне. Входы стадии — original.wav, background.wav, vocals.wav и клипы —
 * не трогаются: их делают более ранние стадии, и они из кэша как раз берутся.
 */
const INTERMEDIATES = ['voice.wav', 'presence.wav', 'duck.wav', 'mixed.wav', 'normalized.wav'] as const;

async function dropIntermediates(workspace: Workspace, config: DubConfig): Promise<void> {
  if (config.cache.keep_intermediate) return;
  let freed = 0;
  for (const name of INTERMEDIATES) {
    const file = workspace.file(name);
    try {
      freed += (await stat(file)).size;
      await rm(file, { force: true });
    } catch {
      // Файла нет — стадия шла другим путём; это не повод для шума.
    }
  }
  if (freed > 0) log.debug(`черновые дорожки удалены, освобождено ${(freed / 1024 / 1024).toFixed(0)} МБ`);
}

export async function runS7(
  workspace: Workspace,
  baseConfig: DubConfig,
  segments: Segment[],
  meta: Meta,
  outputOverride?: string,
  outputDir?: string,
): Promise<S7Result> {
  // Громкости, выставленные в режиме просмотра этого видео, важнее общих настроек.
  const config = applyOverrides(baseConfig, await workspace.readOverrides());
  const warnings: StageWarning[] = [];
  const ffmpeg = await requireTool('ffmpeg', workspace.toolsDir);
  const sourcePath = await resolveSource(workspace, meta);

  const clips: TrackClip[] = segments
    .filter((segment) => (segment.aligned_file ?? segment.tts_file) !== null)
    .map((segment) => ({
      path: (segment.aligned_file ?? segment.tts_file)!,
      startSeconds: segment.start + (segment.shift_ms ?? 0) / 1000,
    }))
    .filter((clip) => existsSync(clip.path));

  const extension = meta.has_video ? '.mp4' : '.m4a';
  const outputPath = resolveOutputPath({
    input: meta.input,
    extension,
    outputOverride,
    outputDir,
    configured: config.output,
  });
  await mkdir(path.dirname(outputPath), { recursive: true });

  // No speech at all: the spec asks for a copy of the input (SPEC §8).
  if (clips.length === 0) {
    warnings.push(warn('warn.s7.noClips', 'Нет синтезированных реплик — итог является копией входа'));
    await copyFile(sourcePath, outputPath);
    return { outputPath, warnings };
  }

  const duration = meta.duration_seconds;
  const sampleRate = config.tts.sample_rate;

  log.step(`сборка голосовой дорожки из ${clips.length} реплик`);
  log.progress('сборка голосовой дорожки', 5, null, { key: 'work.voiceTrack' });
  const voiceTrack = await buildVoiceTrack(clips, duration, sampleRate, workspace.file('voice.wav'));
  if (voiceTrack.collisions > 0) {
    warnings.push(
      warn(
        config.alignment.enabled ? 'warn.s7.collisions' : 'warn.s7.collisionsNoAlign',
        `${voiceTrack.collisions} реплик наложились друг на друга и были сдвинуты вправо` +
          (config.alignment.enabled ? '' : ' (стадия S6 отключена)'),
        { count: voiceTrack.collisions },
      ),
    );
  }

  const separated = workspace.file('background.wav');
  const vocals = workspace.file('vocals.wav');
  const separationReady = config.separation.enabled && existsSync(separated);
  const mode: MixMode = !separationReady
    ? 'duck'
    : config.separation.apply === 'under_speech' && existsSync(vocals)
      ? 'subtract'
      : 'separated';

  const background = mode === 'separated' ? separated : workspace.file('original.wav');
  if (!existsSync(background)) {
    throw new StageError('s7', 'не найдена фоновая дорожка', {
      artifact: background,
      hints: ['Выполните стадию s1 заново: dub process <вход> --from-stage s1'],
    });
  }

  const inputs = ['-i', background, '-i', voiceTrack.path];

  if (mode !== 'separated') {
    const backgroundFormat = await readWavFormat(background);
    if (mode === 'subtract') {
      const windows = spokenWindows(segments);
      // Огибающая присутствия речи: единица под репликами, ноль вне их. Между
      // репликами оригинал остаётся нетронутым, поэтому вокал песен не страдает.
      log.step(
        `убираю исходный голос под речью в ${windows.length} окнах, музыку оставляю` +
          ` (подложка ${config.separation.voice_residual_db} дБ)`,
      );
      log.progress('вычитание исходного голоса', 35, null, { key: 'work.subtract' });
      const presence = await buildSpeechPresenceEnvelope(
        windows,
        duration,
        backgroundFormat.sampleRate,
        {
          fadeMs: config.mix.duck_fade_ms,
          channels: backgroundFormat.channels,
          residualDb: config.separation.voice_residual_db,
        },
        workspace.file('presence.wav'),
      );
      inputs.push('-i', vocals, '-i', presence);
    } else {
      // S4 выключена или не отработала: приглушаем оригинал целиком (ТЗ FR-4).
      const windows = speechWindows(segments, await workspace.readJson<SpeechWindow[]>(workspace.file('speech.json')));
      log.step(`дакинг оригинала на ${config.mix.duck_db} дБ в ${windows.length} речевых окнах`);
      log.progress('приглушение оригинала под речью', 35, null, { key: 'work.duck' });
      const envelope = await buildDuckEnvelope(
        windows,
        duration,
        backgroundFormat.sampleRate,
        { duckDb: config.mix.duck_db, fadeMs: config.mix.duck_fade_ms, channels: backgroundFormat.channels },
        workspace.file('duck.wav'),
      );
      inputs.push('-i', envelope);
    }
  }

  const filters = mixFilters(mode, config.mix.background_gain_db, config.mix.voice_gain_db);

  const mixed = workspace.file('mixed.wav');
  await run(
    ffmpeg,
    ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[mixed]',
     '-ar', '48000', '-acodec', 'pcm_s16le', mixed],
    { timeoutMs: 3_600_000 },
  );

  let finalAudio = mixed;
  if (config.mix.loudnorm) {
    log.step('нормализация громкости (EBU R128, два прохода)');
    log.progress('нормализация громкости', 60, null, { key: 'work.loudnorm' });
    const measured = await measureLoudness(ffmpeg, mixed, config.mix.loudnorm_target_lufs);
    const normalized = workspace.file('normalized.wav');
    const loudnorm = measured
      ? `loudnorm=I=${config.mix.loudnorm_target_lufs}:TP=-1.5:LRA=11:` +
        `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:` +
        `measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`
      : `loudnorm=I=${config.mix.loudnorm_target_lufs}:TP=-1.5:LRA=11`;
    if (!measured) warnings.push(warn('warn.s7.loudnorm', 'Первый проход нормализации не дал измерений — применён однопроходный режим'));

    await run(
      ffmpeg,
      ['-y', '-v', 'error', '-i', mixed, '-af', loudnorm, '-ar', '48000', '-acodec', 'pcm_s16le', normalized],
      { timeoutMs: 3_600_000 },
    );
    finalAudio = normalized;
  }

  log.step(meta.has_video ? 'мультиплексирование (видео копируется)' : 'кодирование аудио');
  log.progress(meta.has_video ? 'сборка итогового видео' : 'кодирование аудио', 85, null, { key: meta.has_video ? 'work.mux' : 'work.encode' });
  const muxArgs = ['-y', '-v', 'error', '-i', sourcePath, '-i', finalAudio];
  const maps: string[] = [];

  if (meta.has_video) {
    maps.push('-map', '0:v:0', '-c:v', 'copy');
  }
  maps.push('-map', '1:a:0');

  if (config.keep_original_track) {
    maps.push('-map', '0:a:0');
    maps.push('-metadata:s:a:0', 'language=rus', '-metadata:s:a:0', 'title=Дубляж (RU)');
    maps.push('-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=Оригинал (EN)');
    maps.push('-disposition:a:0', 'default', '-disposition:a:1', '0');
  } else {
    maps.push('-metadata:s:a:0', 'language=rus');
  }

  muxArgs.push(...maps, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', outputPath);
  await run(ffmpeg, muxArgs, { timeoutMs: 3_600_000 });

  await dropIntermediates(workspace, config);

  return { outputPath, warnings };
}

async function resolveSource(workspace: Workspace, meta: Meta): Promise<string> {
  for (const ext of ['mp4', 'mkv', 'webm', 'm4a', 'mp3', 'opus']) {
    const candidate = workspace.file(`source.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(meta.input)) return path.resolve(meta.input);
  throw new StageError('s7', 'не найден исходный файл для мультиплексирования', {
    artifact: meta.input,
    hints: ['Перезапустите с --from-stage s1'],
  });
}

/**
 * Это уже дубляж, сделанный программой?
 *
 * Итог ложится рядом с исходником и называется `<имя>.ru.<расширение>` — то
 * есть попадает в ту же папку, которую программа показывает списком видео, и
 * ничем от исходников не отличается. Продублировать дубляж ничего не мешает, а
 * результат выглядит как поломка: диаризация делит один синтетический голос на
 * несколько «говорящих», и пол у всех выходит женским — потому что голос по
 * умолчанию женский.
 */
export function isDubbedName(fileName: string): boolean {
  return path.extname(path.basename(fileName, path.extname(fileName))).toLowerCase() === '.ru';
}

export function defaultOutputName(input: string, extension: string): string {
  const base = /^https?:\/\//i.test(input)
    ? 'dubbed'
    : path.basename(input, path.extname(input));
  return `${base}.ru${extension}`;
}

/**
 * Полный путь итога по умолчанию — рядом с исходным файлом (ТЗ FR-7).
 *
 * Раньше возвращалось только имя, а `path.resolve` подставлял текущий каталог:
 * у собранного приложения это служебная папка `%APPDATA%\DubPipe`, и готовый
 * дубляж оказывался не там, где его ищут. Для ссылки исходной папки нет —
 * берётся `fallbackDir` (рабочая папка библиотеки, иначе текущий каталог).
 */
export function defaultOutputPath(input: string, extension: string, fallbackDir?: string): string {
  const name = defaultOutputName(input, extension);
  const dir = /^https?:\/\//i.test(input) ? (fallbackDir ?? process.cwd()) : path.dirname(path.resolve(input));
  return path.join(dir, name);
}

/** Куда ляжет итог: явный путь, папка назначения, настройка или «рядом с исходным». */
export function resolveOutputPath(options: {
  input: string;
  extension: string;
  outputOverride?: string | undefined;
  outputDir?: string | undefined;
  configured?: string | null | undefined;
  fallbackDir?: string | undefined;
}): string {
  const { input, extension, outputOverride, outputDir, configured, fallbackDir } = options;
  if (outputOverride) return path.resolve(outputOverride);
  if (outputDir) return path.join(path.resolve(outputDir), defaultOutputName(input, extension));
  if (configured) return path.resolve(configured);
  return defaultOutputPath(input, extension, fallbackDir);
}
