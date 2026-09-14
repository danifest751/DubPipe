/** Console logging and human-readable stage progress (SPEC §6, §7). */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  yellow: '[33m',
  green: '[32m',
  cyan: '[36m',
};

function colorsEnabled(): boolean {
  if (process.env['NO_COLOR']) return false;
  return process.stderr.isTTY === true;
}

function paint(text: string, color: keyof typeof COLOR): string {
  return colorsEnabled() ? `${COLOR[color]}${text}${COLOR.reset}` : text;
}

/** DEBUG=1 or DUBPIPE_LOG=debug raises verbosity (SPEC §7). */
function initialLevel(): LogLevel {
  const raw = (process.env['DUBPIPE_LOG'] ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  if (process.env['DEBUG']) return 'debug';
  return 'info';
}

/** A log line as the UI receives it: no terminal colouring, structured kind. */
export interface LogRecord {
  level: LogLevel;
  kind: 'message' | 'stage' | 'step' | 'progress';
  text: string;
  at: string;
  /** Present on stage banners so the UI can highlight the running stage. */
  stage?: { id: string; index: number; total: number; title: string };
  /** Ход текущей стадии: доля выполненного и что именно делается. */
  progress?: StageProgress;
}

export interface StageProgress {
  /** 0–100; null — объём заранее неизвестен, показывается только текст. */
  percent: number | null;
  detail: string;
  done?: number;
  total?: number;
  /**
   * То же самое для интерфейса, который умеет говорить на двух языках.
   *
   * `detail` — готовая русская строка: её печатает командная строка, где язык
   * не выбирают. Интерфейс же переводится словарём на странице, поэтому ему
   * нужен ключ и подстановки, а не текст: иначе в английском интерфейсе
   * квадратики стадий остаются русскими.
   */
  phrase?: Phrase;
}

/** Строка, которую интерфейс переведёт сам: ключ словаря и подстановки. */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
}

export type LogListener = (record: LogRecord) => void;

class Logger {
  private level: LogLevel = initialLevel();
  private readonly listeners = new Set<LogListener>();

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Lets the local API mirror the log into its event stream (SPEC FR-U3). */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(record: Omit<LogRecord, 'at'>): void {
    if (this.listeners.size === 0) return;
    const full: LogRecord = { ...record, at: new Date().toISOString() };
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // A broken subscriber must never break the run it is observing.
      }
    }
  }

  private write(level: LogLevel, prefix: string, decorated: string, plain: string): void {
    this.emit({ level, kind: 'message', text: plain });
    if (ORDER[level] < ORDER[this.level]) return;
    process.stderr.write(`${prefix} ${decorated}\n`);
  }

  debug(message: string): void {
    this.write('debug', paint('debug', 'dim'), paint(message, 'dim'), message);
  }

  info(message: string): void {
    this.write('info', paint('·', 'cyan'), message, message);
  }

  warn(message: string): void {
    this.write('warn', paint('!', 'yellow'), message, message);
  }

  error(message: string): void {
    this.write('error', paint('✗', 'red'), message, message);
  }

  success(message: string): void {
    this.write('info', paint('✓', 'green'), message, message);
  }

  /** Stage banner, e.g. "▸ S2 (2/7) Распознавание речи". */
  stage(index: number, total: number, id: string, title: string): void {
    this.emit({
      level: 'info',
      kind: 'stage',
      text: `${id.toUpperCase()} (${index}/${total}) ${title}`,
      stage: { id, index, total, title },
    });
    if (ORDER['info'] < ORDER[this.level]) return;
    const head = paint(`▸ ${id.toUpperCase()}`, 'bold');
    process.stderr.write(`${head} ${paint(`(${index}/${total})`, 'dim')} ${title}\n`);
  }

  /**
   * Ход стадии для интерфейса: полоса, счётчик и подпись. В консоль не пишется —
   * там ту же историю рассказывают строки `step`; здесь важна структура.
   */
  progress(
    detail: string,
    percent: number | null,
    count?: { done: number; total: number } | null,
    phrase?: Phrase,
  ): void {
    const clamped = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
    const computed = count && count.total > 0 ? Math.round((count.done / count.total) * 100) : clamped;
    this.emit({
      level: 'debug',
      kind: 'progress',
      text: detail,
      progress: {
        percent: computed,
        detail,
        ...(count ? { done: count.done, total: count.total } : {}),
        ...(phrase ? { phrase } : {}),
      },
    });
  }

  /** Per-item progress, e.g. "пакет 4/9 переведён". */
  step(message: string): void {
    this.emit({ level: 'info', kind: 'step', text: message });
    if (ORDER['info'] < ORDER[this.level]) return;
    process.stderr.write(`    ${paint(message, 'dim')}\n`);
  }
}

export const log = new Logger();

/** Renders "4/9" style counters for stage progress. */
export function counter(done: number, total: number): string {
  return `${done}/${total}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} мин ${rest} с`;
}
