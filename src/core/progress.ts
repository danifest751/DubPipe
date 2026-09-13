/**
 * Шина прогресса длительных операций.
 *
 * Загрузка компонентов занимает минуты, и без обратной связи интерфейс выглядит
 * зависшим: кнопка погасла, а что происходит — неизвестно. Ядро сообщает о ходе
 * работы структурно, а не строкой в журнале, чтобы интерфейс мог показать
 * полосу выполнения, а CLI — привычный текст.
 */

export type ProgressStatus = 'running' | 'done' | 'error';

export interface ProgressEvent {
  /** Устойчивый ключ операции, например `download:ffmpeg`. */
  id: string;
  kind: 'download' | 'provision' | 'stage';
  label: string;
  status: ProgressStatus;
  /** 0–100; null, когда объём работы заранее неизвестен. */
  percent: number | null;
  receivedBytes?: number;
  totalBytes?: number;
  detail?: string;
  at: string;
}

export type ProgressListener = (event: ProgressEvent) => void;

class ProgressBus {
  private readonly listeners = new Set<ProgressListener>();
  /** Последнее состояние каждой операции — чтобы подключившийся клиент сразу увидел картину. */
  private readonly current = new Map<string, ProgressEvent>();

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: Omit<ProgressEvent, 'at'>): void {
    const full: ProgressEvent = { ...event, at: new Date().toISOString() };

    if (full.status === 'running') this.current.set(full.id, full);
    else this.current.delete(full.id);

    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // Наблюдатель не должен ломать наблюдаемую работу.
      }
    }
  }

  /** Операции, выполняющиеся прямо сейчас. */
  active(): ProgressEvent[] {
    return [...this.current.values()];
  }
}

export const progress = new ProgressBus();

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
}
