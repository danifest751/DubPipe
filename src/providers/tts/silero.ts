import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DubConfig } from '../../config/schema.js';
import { packageRoot } from '../../config/load.js';
import { StageError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import type { Workspace } from '../../core/workspace.js';
import { downloadFile } from '../../util/download.js';
import { killTree, run } from '../../util/exec.js';
import { requireTool } from '../../util/tools.js';
import { wavDuration } from '../../util/wav.js';
import { probePython } from '../../stages/s4-separate.js';
import { SILERO_MODEL, SILERO_VOICES } from './silero-voices.js';
import type { SynthesisRequest, SynthesisResult, TtsProvider } from './index.js';

/**
 * Синтез через silero (ТЗ FR-5): 29 русских дикторов в одной модели на 92 МБ,
 * офлайн, на процессоре.
 *
 * Взят ради того, чего piper дать не может: у piper один русский женский голос,
 * и две героини в фильме звучат одинаково. Попутно оказался в пятнадцать раз
 * быстрее — 0.03 с на реплику против 0.45 с (замер на пятом эпизоде).
 *
 * Модель живёт в процессе на Python, и процесс держится всю стадию: импорт
 * torch и распаковка модели стоят пару секунд, то есть в сто раз дороже самого
 * синтеза. Реплики уходят по одной — модель однопоточная, и параллельные
 * запросы всё равно встали бы в очередь, только в чужую.
 */

/** Silero отдаёт звук только в этих частотах; всё прочее доводится через ffmpeg. */
const NATIVE_RATES = new Set([8000, 24_000, 48_000]);

function sidecarPath(): string {
  const fromPackage = path.join(packageRoot(), 'python', 'silero_tts.py');
  if (existsSync(fromPackage)) return fromPackage;
  // Запуск из dist/: скрипт лежит рядом с корнем пакета.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'python', 'silero_tts.py');
}

interface Pending {
  resolve: (value: { duration: number }) => void;
  reject: (error: Error) => void;
}

export class SileroProvider implements TtsProvider {
  readonly name = 'silero v5_cis_base (локально, CPU)';

  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private starting: Promise<void> | null = null;
  /** Очередь ответов: мост отвечает строго в порядке запросов. */
  private readonly pending: Pending[] = [];
  private failure: Error | null = null;
  private voices: string[] = [];
  /** Цепочка обещаний держит порядок: одна реплика в мосту за раз. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workspace: Workspace,
    private readonly config: DubConfig,
  ) {}

  /**
   * Движок, модель и частота — всё, от чего зависит звучание клипа, кроме
   * голоса и текста. Без модели в отпечатке смена `v5_cis_base` на другую
   * оставила бы на диске клипы, сделанные прежней.
   */
  get fingerprint(): string {
    return `silero:${SILERO_MODEL.name}:${this.config.tts.sample_rate}`;
  }

  async listVoices(): Promise<string[]> {
    // Каталог с замеренным тоном — то, из чего выбирает автоподбор; список
    // нужен и до первого запуска, когда модели ещё нет на диске.
    return SILERO_VOICES.map((voice) => voice.name);
  }

  /** Путь к модели; при первом обращении она скачивается в рабочий каталог. */
  private async ensureModel(): Promise<string> {
    const target = path.join(this.workspace.modelsDir, 'silero', `${SILERO_MODEL.name}.pt`);
    if (!existsSync(target)) {
      await downloadFile(SILERO_MODEL.url, target, {
        label: `модель голосов ${SILERO_MODEL.name}`,
        minBytes: SILERO_MODEL.minBytes,
        timeoutMs: 900_000,
      });
    }
    return target;
  }

  private async start(): Promise<void> {
    const python = await probePython();
    if (python.executable === null) {
      throw new StageError('s5', 'для голосов silero нужен Python, а он не найден', {
        hints: ['Установите Python 3.10+ и повторите', 'Либо вернитесь на piper: tts.engine: piper'],
      });
    }
    const script = sidecarPath();
    if (!existsSync(script)) {
      throw new StageError('s5', 'не найден скрипт синтеза silero', { artifact: script });
    }
    const model = await this.ensureModel();

    const child = spawn(python.executable, ['-X', 'utf8', script, '--model', model], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    const fail = (error: Error): void => {
      this.failure = error;
      // Ждущие реплики не должны висеть вечно, если мост умер.
      while (this.pending.length > 0) this.pending.shift()!.reject(error);
    };
    child.on('error', (error) => {
      fail(error);
    });
    child.on('exit', (code) => {
      if (this.failure === null) {
        fail(new Error(`мост silero завершился (${code ?? 'сигнал'})${stderr ? `\n${stderr.trim()}` : ''}`));
      }
    });

    const reader = createInterface({ input: child.stdout });
    this.reader = reader;

    const ready = new Promise<void>((resolve, reject) => {
      reader.once('line', (line: string) => {
        let payload: { ready?: boolean; voices?: string[]; error?: string };
        try {
          payload = JSON.parse(line) as typeof payload;
        } catch {
          reject(new Error(`мост silero ответил не по протоколу: ${line.slice(0, 200)}`));
          return;
        }
        if (payload.ready !== true) {
          reject(new Error(payload.error ?? 'мост silero не поднялся'));
          return;
        }
        this.voices = payload.voices ?? [];
        resolve();
      });
      // Мост, умерший до первой строки, иначе оставил бы стадию ждать молча.
      child.once('exit', (code) => {
        reject(new Error(`мост silero завершился (${code ?? 'сигнал'})${stderr ? `\n${stderr.trim()}` : ''}`));
      });
    });

    // Остальные строки — ответы на реплики, строго в порядке запросов.
    reader.on('line', (line: string) => {
      const waiting = this.pending.shift();
      if (waiting === undefined) return;
      try {
        const payload = JSON.parse(line) as { ok?: boolean; duration?: number; error?: string };
        if (payload.ok === true && typeof payload.duration === 'number') {
          waiting.resolve({ duration: payload.duration });
        } else {
          waiting.reject(new Error(payload.error ?? 'мост silero не смог синтезировать реплику'));
        }
      } catch {
        waiting.reject(new Error(`мост silero ответил не по протоколу: ${line.slice(0, 200)}`));
      }
    });

    try {
      await ready;
    } catch (cause) {
      this.close();
      throw new StageError('s5', `не удалось поднять голоса silero: ${(cause as Error).message}`, {
        hints: [`${python.executable} -m pip install torch soundfile`, 'Либо вернитесь на piper: tts.engine: piper'],
        cause,
      });
    }
    log.debug(`мост silero поднят, дикторов ${this.voices.length}`);
  }

  private async ensureStarted(): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.starting ??= this.start();
    await this.starting;
  }

  /** Отправляет реплику мосту, соблюдая очередь: ответы приходят по порядку. */
  private ask(request: { text: string; voice: string; out: string; sample_rate: number }): Promise<{ duration: number }> {
    const result = this.tail.then(async () => {
      await this.ensureStarted();
      const child = this.child;
      if (child === null || child.exitCode !== null) throw this.failure ?? new Error('мост silero не запущен');
      return await new Promise<{ duration: number }>((resolve, reject) => {
        this.pending.push({ resolve, reject });
        child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error) reject(error);
        });
      });
    });
    // Хвост не должен обрываться на первой неудаче: иначе следующие реплики
    // получат чужую ошибку, так и не дойдя до моста.
    this.tail = result.catch(() => undefined);
    return result;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    if (!SILERO_VOICES.some((voice) => voice.name === request.voice)) {
      throw new StageError('s5', `движок silero не знает голоса «${request.voice}»`, {
        hints: ['Список голосов: dub voices list', `Например: ${SILERO_VOICES[0]!.name}`],
      });
    }

    const target = this.config.tts.sample_rate;
    const native = NATIVE_RATES.has(target);
    const raw = native ? request.outputPath : `${request.outputPath}.raw.wav`;

    try {
      await this.ask({ text: request.text, voice: request.voice, out: raw, sample_rate: native ? target : 48_000 });
    } catch (cause) {
      throw new StageError('s5', `не удалось синтезировать реплику ${request.id}: ${(cause as Error).message}`, {
        artifact: raw,
        cause,
      });
    }

    if (!native) {
      // Bring every clip to one rate and layout before mixing.
      const ffmpeg = await requireTool('ffmpeg', this.workspace.toolsDir);
      await run(
        ffmpeg,
        ['-y', '-v', 'error', '-i', raw, '-ar', String(target), '-ac', '1', '-acodec', 'pcm_s16le', request.outputPath],
        { timeoutMs: 120_000 },
      );
      await rm(raw, { force: true });
    }

    const duration = await wavDuration(request.outputPath);
    log.debug(`реплика ${request.id}: ${duration.toFixed(2)} с голосом ${request.voice}`);
    return { path: request.outputPath, durationSeconds: duration };
  }

  /** Отпускает процесс: без этого он переживёт стадию и удержит Node. */
  close(): void {
    this.reader?.close();
    this.reader = null;
    if (this.child !== null) {
      this.child.stdin.end();
      killTree(this.child);
      this.child = null;
    }
    this.starting = null;
  }

  /** Short sample used by `dub voices list --demo`. */
  async sample(voice: string, text: string, outputPath: string): Promise<SynthesisResult> {
    return await this.synthesize({ id: -1, text, voice, outputPath: path.resolve(outputPath) });
  }
}
