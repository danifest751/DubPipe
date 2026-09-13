import { DubPipeError, EXIT, type ExitCode } from './errors.js';

/**
 * Остановка прогона по требованию (ТЗ §16.4: «Остановить»).
 *
 * Раньше кнопка лишь помечала задачу — конвейер шёл до конца, а пользователь
 * ждал минуты. Теперь остановка — один сигнал на весь прогон: дочерние процессы
 * (whisper, pyannote, piper, ffmpeg) убиваются немедленно, сетевые запросы к
 * модели обрываются, циклы стадий прекращаются на ближайшей проверке.
 * Незавершённая стадия не записывает отпечаток, поэтому повторный запуск
 * пересчитает её, а готовые стадии возьмутся из кэша.
 */

export class CancelledError extends DubPipeError {
  readonly exitCode: ExitCode = EXIT.CANCELLED;

  constructor(message = 'Остановлено пользователем') {
    super(message);
    this.name = 'CancelledError';
  }
}

class Cancellation {
  private controller: AbortController | null = null;

  /** Начало прогона: новый сигнал; предыдущий, если был, считается завершённым. */
  begin(): AbortSignal {
    this.controller = new AbortController();
    return this.controller.signal;
  }

  end(): void {
    this.controller = null;
  }

  get signal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }

  get requested(): boolean {
    return this.controller?.signal.aborted ?? false;
  }

  /** Остановить текущий прогон; без прогона — ничего не делает. */
  abort(): boolean {
    if (!this.controller || this.controller.signal.aborted) return false;
    this.controller.abort(new CancelledError());
    return true;
  }

  throwIfCancelled(): void {
    if (this.requested) throw new CancelledError();
  }
}

export const cancellation = new Cancellation();

export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError' && cancellation.requested);
}
