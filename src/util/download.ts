import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { log } from '../core/logger.js';
import { progress, formatBytes } from '../core/progress.js';
import { withRetry } from './exec.js';

/**
 * Streaming downloader for tools and model weights (SPEC §15.3). Writes to a
 * .part file and renames on success, so an interrupted download never leaves a
 * truncated artifact that later looks valid.
 */

export interface DownloadOptions {
  /** Expected SHA-256; mismatch is an error naming the component. */
  sha256?: string;
  /** Minimum plausible size in bytes, guards against error pages saved as files. */
  minBytes?: number;
  label?: string;
  timeoutMs?: number;
  /** Number of parallel connections for one file; 1 disables splitting. */
  connections?: number;
}

/** Files smaller than this are not worth splitting across connections. */
const PARALLEL_THRESHOLD_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONNECTIONS = 4;
/**
 * Общий предел одновременных соединений.
 *
 * Компоненты качаются параллельно, и каждый ещё делится на части: без общего
 * предела десятки соединений начинают мешать друг другу и упираются в канал,
 * а не ускоряют загрузку.
 */
const MAX_TOTAL_CONNECTIONS = 8;

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

const connectionLimit = new Semaphore(MAX_TOTAL_CONNECTIONS);

/**
 * Пауза без единого байта, после которой соединение считается застывшим.
 *
 * Общий таймаут на запрос — десять минут: ровно столько зависшее соединение
 * держало бы полосу загрузки на 99%, прежде чем его повторили. Сторож простоя
 * обрывает такое соединение за секунды, а докачка продолжает с места обрыва.
 */
const STALL_MS = 20_000;

class StallGuard {
  private timer: NodeJS.Timeout | undefined;
  stalled = false;

  constructor(private readonly controller: AbortController, private readonly limitMs: number) {
    this.touch();
  }

  /** Вызывается на каждом полученном куске данных. */
  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stalled = true;
      this.controller.abort();
    }, this.limitMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

export interface ChunkRange {
  start: number;
  end: number;
}

/**
 * Делит файл на непрерывные диапазоны байт. Чистая функция — проверяется тестами
 * без обращения к сети.
 */
export function planChunks(size: number, parts: number): ChunkRange[] {
  if (size <= 0) return [];
  const count = Math.max(1, Math.min(Math.floor(parts), size));
  const base = Math.floor(size / count);
  const ranges: ChunkRange[] = [];

  let start = 0;
  for (let index = 0; index < count; index++) {
    // Остаток от деления отдаём последней части, чтобы покрыть файл целиком.
    const length = index === count - 1 ? size - start : base;
    ranges.push({ start, end: start + length - 1 });
    start += length;
  }
  return ranges;
}

interface RangeSupport {
  supported: boolean;
  size: number;
}

/**
 * Проверяет поддержку докачки по диапазонам запросом одного байта: HEAD
 * поддерживают не все зеркала, а Range-ответ 206 однозначен.
 */
async function probeRange(url: string, timeoutMs: number): Promise<RangeSupport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 30_000));
  try {
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
      redirect: 'follow',
    });
    await response.body?.cancel();

    if (response.status !== 206) return { supported: false, size: 0 };
    const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(response.headers.get('content-range') ?? '');
    const size = match ? Number(match[1]) : 0;
    return { supported: size > 0, size };
  } catch {
    return { supported: false, size: 0 };
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Downloads already running, keyed by target path. Stages synthesise replicas
 * in parallel, and without this two workers would fetch the same voice at once
 * and corrupt each other's partial file.
 */
const inFlight = new Map<string, Promise<string>>();

export async function downloadFile(url: string, target: string, options: DownloadOptions = {}): Promise<string> {
  const existing = inFlight.get(target);
  if (existing) return await existing;

  const task = downloadFileOnce(url, target, options)
    .catch((error: unknown) => {
      progress.emit({
        id: `download:${path.basename(target)}`,
        kind: 'download',
        label: options.label ?? path.basename(target),
        status: 'error',
        percent: null,
        detail: (error as Error).message,
      });
      throw error;
    })
    .finally(() => inFlight.delete(target));
  inFlight.set(target, task);
  return await task;
}

async function downloadFileOnce(url: string, target: string, options: DownloadOptions = {}): Promise<string> {
  const label = options.label ?? path.basename(target);
  const progressId = `download:${path.basename(target)}`;
  if (existsSync(target)) {
    log.debug(`${label}: уже загружен (${target})`);
    return target;
  }

  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const connections = options.connections ?? DEFAULT_CONNECTIONS;

  // Многопоточная загрузка, когда зеркало умеет отдавать диапазоны байт
  // и файл достаточно велик, чтобы деление окупилось.
  if (connections > 1) {
    const range = await probeRange(url, timeoutMs);
    if (range.supported && range.size >= PARALLEL_THRESHOLD_BYTES) {
      try {
        await downloadRanged(url, partial, range.size, connections, timeoutMs, label, progressId);
        await finishDownload(partial, target, label, progressId, options);
        return target;
      } catch (error) {
        // Зеркало может принимать диапазоны, но плохо переносить несколько
        // соединений сразу. Тогда честнее скачать одним потоком, чем сдаться.
        log.warn(`${label}: многопоточная загрузка не удалась (${(error as Error).message}), качаю одним потоком`);
      }
    }
  }

  await withRetry(
    async () => {
      await rm(partial, { force: true });
      const controller = new AbortController();
      const guard = new StallGuard(controller, STALL_MS);
      const timer = options.timeoutMs
        ? setTimeout(() => controller.abort(), options.timeoutMs)
        : undefined;
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status} при загрузке ${url}`);
        }
        const total = Number(response.headers.get('content-length') ?? 0);
        log.info(`Загрузка ${label}${total ? ` (${formatBytes(total)})` : ''}…`);
        progress.emit({
          id: progressId,
          kind: 'download',
          label,
          status: 'running',
          percent: total ? 0 : null,
          receivedBytes: 0,
          totalBytes: total,
        });

        const hash = createHash('sha256');
        let received = 0;
        let lastReport = Date.now();
        const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        source.on('data', (chunk: Buffer) => {
          guard.touch();
          hash.update(chunk);
          received += chunk.length;
          // Событий много, а перерисовка нужна не чаще нескольких раз в секунду.
          if (Date.now() - lastReport > 400) {
            lastReport = Date.now();
            progress.emit({
              id: progressId,
              kind: 'download',
              label,
              status: 'running',
              percent: total ? Math.round((received / total) * 100) : null,
              receivedBytes: received,
              totalBytes: total,
            });
            if (total) log.step(`${label}: ${Math.round((received / total) * 100)}%`);
          }
        });

        try {
          await pipeline(source, createWriteStream(partial));
        } catch (error) {
          if (guard.stalled) throw new Error(`соединение застыло на ${Math.round(STALL_MS / 1000)} с`);
          throw error;
        }

        const digest = hash.digest('hex');
        if (options.sha256 && digest !== options.sha256) {
          throw new Error(
            `Контрольная сумма ${label} не совпала: ожидалось ${options.sha256}, получено ${digest}`,
          );
        }
      } finally {
        guard.stop();
        if (timer) clearTimeout(timer);
      }
    },
    { attempts: 3, baseDelayMs: 1000 },
  );

  await finishDownload(partial, target, label, progressId, options);
  return target;
}

/** Переименование и отметка о завершении — общий хвост обоих режимов загрузки. */
async function finishDownload(
  partial: string,
  target: string,
  label: string,
  progressId: string,
  options: DownloadOptions,
): Promise<void> {
  const info = await stat(partial);
  if (options.minBytes && info.size < options.minBytes) {
    throw new Error(
      `Файл ${label} подозрительно мал (${formatBytes(info.size)} < ${formatBytes(options.minBytes)}); ` +
        'вероятно, сервер вернул страницу ошибки',
    );
  }

  await rename(partial, target);
  progress.emit({
    id: progressId,
    kind: 'download',
    label,
    status: 'done',
    percent: 100,
    receivedBytes: info.size,
    totalBytes: info.size,
  });
  log.success(`${label} — готово (${formatBytes(info.size)})`);
}

/**
 * Загрузка файла несколькими соединениями.
 *
 * Части пишутся сразу по своим смещениям в один файл, поэтому память не растёт
 * с размером загрузки. Каждая часть повторяется независимо: обрыв одного
 * соединения не отменяет уже скачанное остальными.
 */
async function downloadRanged(
  url: string,
  partial: string,
  size: number,
  connections: number,
  timeoutMs: number,
  label: string,
  progressId: string,
): Promise<void> {
  await rm(partial, { force: true });
  const chunks = planChunks(size, connections);
  const handle = await open(partial, 'w');

  let received = 0;
  let lastReport = 0;
  const report = (force = false): void => {
    if (!force && Date.now() - lastReport < 400) return;
    lastReport = Date.now();
    progress.emit({
      id: progressId,
      kind: 'download',
      label,
      status: 'running',
      percent: Math.round((received / size) * 100),
      receivedBytes: received,
      totalBytes: size,
    });
  };

  log.info(`Загрузка ${label} (${formatBytes(size)}, соединений: ${chunks.length})…`);
  report(true);

  try {
    await Promise.all(
      chunks.map((chunk) => {
        // Сколько байт части уже лежит в файле. Переживает повторы: новая попытка
        // просит у сервера только остаток, а не всю часть заново — поэтому полоса
        // хода не откатывается назад и трафик не тратится дважды.
        let written = 0;
        const expected = chunk.end - chunk.start + 1;

        return withRetry(
          async () => {
            if (written >= expected) return;
            const release = await connectionLimit.acquire();
            const controller = new AbortController();
            const guard = new StallGuard(controller, STALL_MS);
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const response = await fetch(url, {
                headers: { Range: `bytes=${chunk.start + written}-${chunk.end}` },
                signal: controller.signal,
                redirect: 'follow',
              });
              if (response.status !== 206 || !response.body) {
                throw new Error(`сервер ответил ${response.status} на запрос диапазона`);
              }

              for await (const part of Readable.fromWeb(
                response.body as Parameters<typeof Readable.fromWeb>[0],
              )) {
                const buffer = part as Buffer;
                guard.touch();
                await handle.write(buffer, 0, buffer.length, chunk.start + written);
                written += buffer.length;
                received += buffer.length;
                report();
              }

              if (written !== expected) {
                throw new Error(`часть получена не полностью: ${written} из ${expected} байт`);
              }
            } catch (error) {
              if (guard.stalled) {
                throw new Error(`соединение застыло на ${Math.round(STALL_MS / 1000)} с (получено ${formatBytes(written)} из ${formatBytes(expected)})`);
              }
              throw error;
            } finally {
              guard.stop();
              clearTimeout(timer);
              release();
            }
          },
          {
            attempts: 6,
            baseDelayMs: 800,
            onRetry: (attempt, error) =>
              log.debug(`${label}: часть ${chunk.start}: попытка ${attempt} — ${(error as Error).message}`),
          },
        );
      }),
    );
  } finally {
    await handle.close();
  }

  const info = await stat(partial);
  if (info.size !== size) {
    throw new Error(`Размер ${label} не совпал: ожидалось ${size}, получено ${info.size} байт`);
  }
  report(true);
}
