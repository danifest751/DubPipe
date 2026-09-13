import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { DubConfig } from '../../config/schema.js';
import { packageRoot } from '../../config/load.js';
import { log } from '../../core/logger.js';
import { progress } from '../../core/progress.js';
import { makeSegment, type Segment } from '../../core/types.js';
import { run, ProcessError } from '../../util/exec.js';

/**
 * Диаризация спикеров через pyannote (SPEC FR-2, §12.2).
 *
 * whisper.cpp не различает говорящих, а pyannote живёт только в PyTorch, поэтому
 * модель запускается Python-сайдкаром — так же, как разделение голоса на S4.
 * Стадия необязательна: при любой неполадке реплики остаются со `speaker_0`,
 * а причина попадает в предупреждения и в «Окружение» интерфейса.
 */

export interface DiarizationTurn {
  start: number;
  end: number;
  speaker: string;
}

export interface DiarizationProbe {
  /** Исполняемый файл Python или null, если его нет вовсе. */
  python: string | null;
  /** pyannote.audio и PyTorch импортируются. */
  installed: boolean;
  /** Токен Hugging Face задан в переменной окружения. */
  tokenSet: boolean;
  /** Веса модели уже скачаны — можно работать без сети. */
  weightsReady: boolean;
  /** Всё на месте: можно запускать. */
  available: boolean;
  /** Человекочитаемая причина недоступности. */
  reason: string | null;
  /** Что сделать, чтобы починить. */
  hint: string | null;
}

/** Каталог кэша Hugging Face внутри каталога моделей программы. */
export function hfCacheDir(modelsDir: string): string {
  return path.join(modelsDir, 'hf');
}

/** Файл-метка «веса этой модели скачаны»: pyannote тянет несколько репозиториев, проверять каждый — хрупко. */
export function weightsMarker(model: string, modelsDir: string): string {
  return path.join(hfCacheDir(modelsDir), `.ready-${model.replace(/[^A-Za-z0-9_.-]+/g, '_')}`);
}

export function sidecarPath(): string {
  const fromPackage = path.join(packageRoot(), 'python', 'diarize.py');
  if (existsSync(fromPackage)) return fromPackage;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'python', 'diarize.py');
}

let pythonCache: { executable: string | null; installed: boolean } | null = null;

/** Забыть результат проверки — после установки модулей она должна повториться. */
export function resetDiarizationProbe(): void {
  pythonCache = null;
}

async function findPython(): Promise<{ executable: string | null; installed: boolean }> {
  if (pythonCache) return pythonCache;
  const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  const script = sidecarPath();
  let found: string | null = null;
  for (const executable of candidates) {
    try {
      await run(executable, ['-c', 'import sys; print(sys.version_info[0])'], { timeoutMs: 30_000 });
      found = executable;
    } catch {
      continue;
    }
    try {
      // Импорт torch занимает секунды; результат кэшируется на время сеанса.
      await run(executable, [script, '--probe'], { timeoutMs: 120_000 });
      pythonCache = { executable, installed: true };
      return pythonCache;
    } catch {
      break;
    }
  }
  pythonCache = { executable: found, installed: false };
  return pythonCache;
}

export async function probeDiarization(config: DubConfig, modelsDir: string): Promise<DiarizationProbe> {
  const { model, hf_token_env: tokenEnv } = config.asr.diarization;
  const python = await findPython();
  const tokenSet = Boolean(process.env[tokenEnv]);
  const weightsReady = existsSync(weightsMarker(model, modelsDir));

  let reason: string | null = null;
  let hint: string | null = null;
  if (!python.executable) {
    reason = 'Python не найден';
    hint = 'Установите Python 3.10+ (python.org) и перезапустите программу';
  } else if (!python.installed) {
    reason = 'не установлен pyannote.audio (PyTorch)';
    hint = 'нажмите «Догрузить недостающее» — модули будут установлены автоматически';
  } else if (!weightsReady && !tokenSet) {
    reason = 'нет токена Hugging Face для загрузки весов';
    hint = 'введите токен в настройках распознавания и нажмите «Догрузить недостающее»';
  } else if (!weightsReady) {
    reason = 'веса модели ещё не загружены';
    hint = 'нажмите «Догрузить недостающее»';
  }

  return {
    python: python.executable,
    installed: python.installed,
    tokenSet,
    weightsReady,
    available: reason === null,
    reason,
    hint,
  };
}

const INSTALL_PROGRESS_ID = 'provision:pyannote';

/**
 * Устанавливает pyannote.audio (с PyTorch) и скачивает веса модели.
 * Ход показывается в интерфейсе одной полосой: pip печатает много, но
 * пользователю важно лишь, что процесс жив и что именно происходит.
 */
export async function installDiarization(config: DubConfig, modelsDir: string): Promise<void> {
  const label = 'диаризация (pyannote + PyTorch)';
  const emit = (status: 'running' | 'done' | 'error', detail: string, percent: number | null = null) =>
    progress.emit({ id: INSTALL_PROGRESS_ID, kind: 'provision', label, status, percent, detail });

  resetDiarizationProbe();
  let probe = await probeDiarization(config, modelsDir);
  const python = probe.python;
  if (!python) throw new Error(`${probe.reason}. ${probe.hint}`);

  if (!probe.installed) {
    emit('running', 'установка pyannote.audio и PyTorch (около 1 ГБ)…');
    let lastLine = '';
    const onOutput = (chunk: string) => {
      const line = chunk.trim().split('\n').pop() ?? '';
      const match = /(Collecting|Downloading|Installing collected packages|Successfully installed)\s*(\S*)/.exec(line);
      if (match && line !== lastLine) {
        lastLine = line;
        emit('running', `${match[1]} ${match[2]}`.trim().slice(0, 120));
      }
    };
    try {
      await run(python, ['-m', 'pip', 'install', '--upgrade', '--progress-bar', 'off', 'pyannote.audio>=4'], {
        timeoutMs: 3_600_000,
        onStderr: onOutput,
      });
    } catch (error) {
      const detail = error instanceof ProcessError ? error.stderr.trim().split('\n').slice(-2).join('; ') : (error as Error).message;
      emit('error', `pip: ${detail}`);
      throw new Error(`не удалось установить pyannote.audio: ${detail}`);
    }
    resetDiarizationProbe();
    probe = await probeDiarization(config, modelsDir);
    if (!probe.installed) {
      emit('error', 'модули установлены, но не импортируются');
      throw new Error('pyannote.audio установлен, но не импортируется — см. вывод pip');
    }
  }

  if (!probe.weightsReady) {
    if (!probe.tokenSet) {
      emit('error', probe.reason ?? 'нет токена');
      throw new Error(`${probe.reason}. ${probe.hint}`);
    }
    emit('running', 'загрузка весов модели с Hugging Face…');
    try {
      await run(
        python,
        [
          sidecarPath(),
          '--warmup',
          '--model',
          config.asr.diarization.model,
          '--cache-dir',
          hfCacheDir(modelsDir),
          '--token-env',
          config.asr.diarization.hf_token_env,
        ],
        { timeoutMs: 1_800_000 },
      );
    } catch (error) {
      const detail = sidecarError(error);
      emit('error', detail);
      throw new Error(detail);
    }
    await mkdir(hfCacheDir(modelsDir), { recursive: true });
    await writeFile(weightsMarker(config.asr.diarization.model, modelsDir), new Date().toISOString(), 'utf8');
  }

  emit('done', 'готово', 100);
}

/** Сайдкар печатает причину отказа JSON-строкой в stderr; вытащить её, а не хвост трассировки. */
function sidecarError(error: unknown): string {
  if (error instanceof ProcessError) {
    const lines = error.stderr.trim().split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines.reverse()) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line) as { error?: string };
        if (parsed.error) return parsed.error;
      } catch {
        // не JSON — ищем дальше
      }
    }
    return lines.slice(-2).join('; ') || error.message;
  }
  return (error as Error).message;
}

/** Запускает диаризацию; результат сохраняется в `outputPath` и возвращается. */
export async function diarize(
  config: DubConfig,
  modelsDir: string,
  audioPath: string,
  outputPath: string,
): Promise<DiarizationTurn[]> {
  const probe = await probeDiarization(config, modelsDir);
  if (!probe.available || !probe.python) {
    throw new Error(`${probe.reason}. ${probe.hint}`);
  }

  const args = [
    sidecarPath(),
    '--input',
    audioPath,
    '--output',
    outputPath,
    '--model',
    config.asr.diarization.model,
    '--max-speakers',
    String(config.asr.diarization.max_speakers),
    '--cache-dir',
    hfCacheDir(modelsDir),
    '--token-env',
    config.asr.diarization.hf_token_env,
    // Веса на месте — в сеть не ходим: без этого хаб проверяет версии
    // при каждом запуске и падает без подключения.
    '--offline',
  ];

  let lastPercent = -1;
  try {
    await run(probe.python, args, {
      timeoutMs: 6 * 3_600_000,
      onStderr: (chunk) => {
        const match = /progress=(\d+)/.exec(chunk);
        if (match) {
          const percent = Number(match[1]);
          log.progress(`диаризация ${percent}%`, percent);
          if (percent - lastPercent >= 10 || percent === 100) {
            lastPercent = percent;
            log.step(`диаризация ${percent}%`);
          }
        } else if (chunk.trim() && !chunk.includes('Warning') && !chunk.includes('warn')) {
          log.debug(chunk.trim());
        }
      },
    });
  } catch (error) {
    throw new Error(sidecarError(error));
  }

  const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as { turns?: DiarizationTurn[] };
  return (parsed.turns ?? []).filter((turn) => turn.end > turn.start);
}

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function distance(a: { start: number; end: number }, b: { start: number; end: number }): number {
  if (overlap(a, b) > 0) return 0;
  return a.start >= b.end ? a.start - b.end : b.start - a.end;
}

/**
 * Имена спикеров pyannote (SPEAKER_00…) переводятся в `speaker_N` в порядке
 * первого появления в записи: тот, кто говорит первым, — `speaker_0`. Так
 * voice_map остаётся осмысленным для человека, который смотрит ролик с начала.
 */
export function speakerNames(turns: DiarizationTurn[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const turn of [...turns].sort((a, b) => a.start - b.start)) {
    if (!names.has(turn.speaker)) names.set(turn.speaker, `speaker_${names.size}`);
  }
  return names;
}

/**
 * Спикер интервала: наибольшее перекрытие, при его отсутствии — ближайший ход
 * не дальше `nearestWithin` секунд (0 — только по перекрытию).
 */
export function speakerFor(
  interval: { start: number; end: number },
  turns: DiarizationTurn[],
  names: Map<string, string>,
  fallback = 'speaker_0',
  nearestWithin = 1,
): string {
  const totals = new Map<string, number>();
  for (const turn of turns) {
    const shared = overlap(interval, turn);
    if (shared > 0) totals.set(turn.speaker, (totals.get(turn.speaker) ?? 0) + shared);
  }
  let best: string | null = null;
  let bestValue = 0;
  for (const [speaker, value] of totals) {
    if (value > bestValue) {
      best = speaker;
      bestValue = value;
    }
  }
  if (best === null) {
    let nearest: DiarizationTurn | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const turn of turns) {
      const gap = distance(interval, turn);
      if (gap < nearestDistance) {
        nearest = turn;
        nearestDistance = gap;
      }
    }
    // Дальше секунды от любой речи — это не «его» реплика, оставляем общий голос.
    if (!nearest || nearestDistance > nearestWithin) return fallback;
    best = nearest.speaker;
  }
  return names.get(best) ?? fallback;
}

/** Минимальная часть реплики, которую стоит отделять другому спикеру. */
export const MIN_SPLIT_SECONDS = 0.6;
export const MIN_SPLIT_WORDS = 2;

/**
 * Назначает спикеров репликам и режет реплику там, где внутри неё сменился
 * говорящий (диалог без паузы whisper склеивает в одну строку). Режется только
 * по границам слов и лишь когда обе части — полноценные реплики; иначе одна
 * оговорка модели диаризации плодила бы обрывки.
 */
export function assignSpeakers(segments: Segment[], turns: DiarizationTurn[]): Segment[] {
  if (turns.length === 0) return segments;
  const names = speakerNames(turns);
  const result: Segment[] = [];

  for (const segment of segments) {
    const pieces = splitBySpeaker(segment, turns, names);
    result.push(...pieces);
  }

  return result
    .sort((a, b) => a.start - b.start)
    .map((segment, index) => ({ ...segment, id: index }));
}

function splitBySpeaker(segment: Segment, turns: DiarizationTurn[], names: Map<string, string>): Segment[] {
  const whole = speakerFor(segment, turns, names);
  const words = segment.words;
  if (!words || words.length < MIN_SPLIT_WORDS * 2) return [{ ...segment, speaker: whole }];

  // Группы подряд идущих слов одного спикера. Слово, не покрытое ни одним
  // ходом, наследует спикера реплики: резать по «ближайшему» ходу нельзя —
  // на пропущенной диаризацией фразе половина слов тянется к предыдущему
  // говорящему, половина к следующему, и фраза рвётся посередине.
  const runs: Array<{ speaker: string; words: typeof words }> = [];
  for (const word of words) {
    const speaker = speakerFor(word, turns, names, whole, 0);
    const last = runs[runs.length - 1];
    if (last && last.speaker === speaker) last.words.push(word);
    else runs.push({ speaker, words: [word] });
  }
  if (runs.length < 2) return [{ ...segment, speaker: whole }];

  // Слишком короткие вкрапления присоединяются к соседям: это шум диаризации.
  const solid = (run: { words: typeof words }) =>
    run.words.length >= MIN_SPLIT_WORDS &&
    run.words[run.words.length - 1]!.end - run.words[0]!.start >= MIN_SPLIT_SECONDS;
  const merged: typeof runs = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && (!solid(run) || !solid(last))) {
      if (!solid(last) && solid(run)) last.speaker = run.speaker;
      last.words.push(...run.words);
    } else if (last && last.speaker === run.speaker) {
      last.words.push(...run.words);
    } else {
      merged.push({ speaker: run.speaker, words: [...run.words] });
    }
  }
  if (merged.length < 2) return [{ ...segment, speaker: whole }];

  return merged.map((run, index) => {
    const first = run.words[0]!;
    const last = run.words[run.words.length - 1]!;
    return makeSegment({
      ...segment,
      id: segment.id,
      start: index === 0 ? segment.start : Number(first.start.toFixed(3)),
      end: index === merged.length - 1 ? segment.end : Number(last.end.toFixed(3)),
      text_en: run.words.map((word) => word.word).join(' ').replace(/\s+/g, ' ').trim(),
      speaker: run.speaker,
      words: run.words,
      flags: [...segment.flags, 'force_split'],
    });
  });
}
