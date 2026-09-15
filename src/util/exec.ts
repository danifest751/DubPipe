import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { log } from '../core/logger.js';
import { CancelledError, cancellation, isCancelled } from '../core/cancel.js';

/**
 * External process execution with timeouts, retries and readable failures
 * (SPEC §0.5). Arguments are always passed as an array — never through a shell —
 * so paths with spaces and non-ASCII characters are safe on every platform
 * (SPEC §7 portability).
 */

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Копить ли stdout процесса и вернуть его в `RunResult`.
   *
   * По умолчанию — нет: болтливый инструмент иначе растит память прогона
   * молча, а stderr для этого обрезается (см. ниже). Кому вывод нужен для
   * разбора — просит явно; `ffmpeg` и `whisper` печатают туда гигабайты, а
   * `ProcessError` и без этого приносит хвост stderr.
   */
  captureStdout?: boolean;
  input?: Buffer | string;
  /**
   * Called with each stdout chunk, e.g. to parse progress.
   *
   * В отличие от `captureStdout`, поток не накапливается: yt-dlp за час
   * загрузки печатает тысячи строк, и держать их в памяти незачем — из каждой
   * нужны только числа.
   */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk, e.g. to parse progress. */
  onStderr?: (chunk: string) => void;
  /** Сигнал остановки; по умолчанию — сигнал текущего прогона. */
  signal?: AbortSignal;
}

/** Убивает процесс и всё его дерево: на Windows дочерние процессы сами не умирают. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
    } catch {
      // taskkill недоступен — ниже обычный kill
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // процесс уже завершился
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ProcessError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  readonly command: string;

  constructor(command: string, code: number | null, stderr: string, note?: string) {
    const tail = stderr.trim().split('\n').slice(-8).join('\n');
    super(
      `Команда завершилась с ошибкой (${code ?? 'сигнал'}): ${command}` +
        (note ? `\n${note}` : '') +
        (tail ? `\n${tail}` : ''),
    );
    this.name = 'ProcessError';
    this.code = code;
    this.stderr = stderr;
    this.command = command;
  }
}

export class TimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`Команда не уложилась в ${Math.round(timeoutMs / 1000)} с и была прервана: ${command}`);
    this.name = 'TimeoutError';
  }
}

export async function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 0, captureStdout = false } = options;
  const pretty = `${file} ${args.join(' ')}`;
  log.debug(`exec: ${pretty}`);

  const spawnOptions: SpawnOptions = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    windowsHide: true,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  };

  const cancelSignal = options.signal ?? cancellation.signal;
  if (cancelSignal?.aborted) throw new CancelledError();

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(file, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let cancelled = false;

    // Остановка по требованию: процесс убивается вместе с потомками
    // (py-лончер запускает python отдельным процессом), обещание отклоняется.
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    cancelSignal?.addEventListener('abort', onAbort, { once: true });
    const detach = () => cancelSignal?.removeEventListener('abort', onAbort);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      options.onStdout?.(text);
      if (captureStdout) stdout += text;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Keep memory bounded on chatty tools such as ffmpeg.
      stderr = (stderr + text).slice(-64_000);
      options.onStderr?.(text);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      detach();
      if (error.code === 'ENOENT') {
        reject(new ProcessError(pretty, null, '', `Исполняемый файл не найден: ${file}`));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      detach();
      if (cancelled) {
        reject(new CancelledError());
        return;
      }
      if (timedOut) {
        reject(new TimeoutError(pretty, timeoutMs));
        return;
      }
      if (code !== 0) {
        reject(new ProcessError(pretty, code, stderr));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to fail fast without consuming further attempts. */
  retryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter (SPEC §8: up to 3 retries for network calls). */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 500, maxDelayMs = 15_000, retryable = () => true, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    cancellation.throwIfCancelled();
    try {
      return await task();
    } catch (error) {
      // Остановка — не сбой: повторять нечего.
      if (isCancelled(error)) throw error instanceof CancelledError ? error : new CancelledError();
      lastError = error;
      if (attempt === attempts || !retryable(error)) break;
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));
      onRetry?.(attempt, error, delay);
      log.debug(`повтор ${attempt}/${attempts - 1} через ${delay} мс: ${(error as Error).message}`);
      await sleep(delay);
    }
  }
  throw lastError;
}
