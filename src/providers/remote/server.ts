import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { LOCAL_DEFAULT_MODEL, type DubConfig } from '../../config/schema.js';
import { cancellation, CancelledError } from '../../core/cancel.js';
import { log } from '../../core/logger.js';
import { run } from '../../util/exec.js';

/**
 * Сервер с видеокартой: куда отдавать тяжёлые сети конвейера.
 *
 * Конвейер живёт на рабочем компьютере — там файлы, интерфейс, ffmpeg, — а
 * распознавание, разбор по голосам, отделение голоса и синтез уходят на машину
 * с видеокартой, где запущен `python/dubpipe_worker.py`. Перевод идёт в Ollama
 * той же машины. Сервис запускает те же скрипты, что и локальный путь, поэтому
 * результат не зависит от того, где считали, — меняется только скорость.
 *
 * Видеокарта может стоять и в самом рабочем компьютере. Тогда сервер не нужен:
 * `server.host` пуст, скрипты запускаются здесь и сами берут CUDA.
 */

export type ServerStage = 'asr' | 'diarization' | 'separation' | 'tts' | 'clone' | 'translate';

/** Сервер используется: адрес задан и в настройках выбран «сервер с видеокартой». */
export function serverEnabled(config: DubConfig): boolean {
  return config.server.enabled && config.server.host !== null;
}

/** Стадия считается на сервере: сервер включён и стадия ему отдана. */
export function onServer(config: DubConfig, stage: ServerStage): boolean {
  return serverEnabled(config) && config.server.stages[stage];
}

/**
 * Модель Ollama на сервере по умолчанию. gemma4 26B-A4B — самая быстрая из
 * больших на CMP 50HX: 106 токенов в секунду при качестве уровня 27B.
 */
export const SERVER_DEFAULT_MODEL = 'gemma4:26b-a4b-it-qat';

/** Адрес узла для URL: IPv6 в квадратных скобках. */
function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function workerUrl(config: DubConfig): string | null {
  const { host, worker_port: port } = config.server;
  return host === null || !config.server.enabled ? null : `http://${hostForUrl(host)}:${port}`;
}

export function serverOllamaUrl(config: DubConfig): string | null {
  const { host, ollama_port: port } = config.server;
  return host === null ? null : `http://${hostForUrl(host)}:${port}`;
}

/**
 * Подставляет сервер в настройки перевода.
 *
 * Отдать перевод серверу значит отдать и его Ollama, и его модель: на сервере
 * стоят свои модели, и имя `qwen2.5:7b-instruct` с рабочего компьютера там
 * ничего не значит. Поэтому, когда перевод отдан серверу, адрес Ollama и имя
 * локальной модели берутся из раздела `server`, что бы ни стояло в `translate`.
 * Облачный перевод профиля hybrid это не трогает: сервер становится его
 * запасным путём вместо Ollama на этом компьютере.
 */
export function applyServer(config: DubConfig): DubConfig {
  const endpoint = onServer(config, 'translate') ? serverOllamaUrl(config) : null;
  if (endpoint === null) return config;
  /*
   * Нетронутая модель по умолчанию (qwen2.5:7b) рассчитана на Ollama этого
   * компьютера и на сервере её нет — там её заменяет серверная по умолчанию.
   * Выбранную человеком модель не трогаем: список в поле модели берётся с
   * того Ollama, где идёт перевод, значит, она оттуда. Явная
   * `server.translate_model` сильнее всего.
   */
  const local = (name: string) => config.server.translate_model ?? (name === LOCAL_DEFAULT_MODEL ? SERVER_DEFAULT_MODEL : name);
  return {
    ...config,
    translate: {
      ...config.translate,
      ollama_endpoint: endpoint,
      fallback_model: local(config.translate.fallback_model),
      model: config.translate.engine === 'ollama' ? local(config.translate.model) : config.translate.model,
    },
  };
}

export interface WorkerHealth {
  ok: boolean;
  protocol: number;
  capabilities: { asr: boolean; diarization: boolean; separation: boolean; tts: boolean; clone?: boolean; clone_check?: boolean };
  gpu: {
    name: string;
    memory_used_mb: number;
    memory_total_mb: number;
    utilization: number;
    temperature: number;
  } | null;
  running: string | null;
  waiting: number;
}

/** Версия протокола, которую понимает этот клиент. */
export const WORKER_PROTOCOL = 1;

interface HttpResult {
  status: number;
  body: Buffer;
  headers: http.IncomingHttpHeaders;
}

/** Один запрос с телом целиком; сетевые ошибки — исключением. */
function request(
  url: string,
  options: { method?: string; body?: Buffer | string; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal | null },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? 'GET', headers: options.headers, timeout: options.timeoutMs ?? 10_000, signal: options.signal ?? undefined },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('сервер не ответил вовремя')));
    req.on('error', reject);
    req.end(options.body);
  });
}

const healthCache = new Map<string, { at: number; value: WorkerHealth | null }>();

/** Забыть ответы сервера — после смены адреса в настройках. */
export function resetWorkerHealth(): void {
  healthCache.clear();
}

/**
 * Жив ли сервис и что он умеет. Ответ держится несколько секунд: экран
 * готовности опрашивается часто, а стадии спрашивают перед каждым заходом.
 */
export async function workerHealth(config: DubConfig, maxAgeMs = 5000): Promise<WorkerHealth | null> {
  const base = workerUrl(config);
  if (base === null) return null;
  const cached = healthCache.get(base);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
  let value: WorkerHealth | null = null;
  try {
    const { status, body } = await request(`${base}/health`, { timeoutMs: 4000 });
    if (status === 200) {
      const parsed = JSON.parse(body.toString('utf8')) as WorkerHealth;
      if (parsed.ok && parsed.protocol === WORKER_PROTOCOL) value = parsed;
      else log.debug(`сервис ${base} отвечает по протоколу ${parsed.protocol}, а клиент знает ${WORKER_PROTOCOL}`);
    }
  } catch (error) {
    log.debug(`сервис ${base} недоступен: ${(error as Error).message}`);
  }
  healthCache.set(base, { at: Date.now(), value });
  return value;
}

/** Почему стадию нельзя отдать серверу, или null, если можно. */
export async function serverUnavailable(
  config: DubConfig,
  capability: keyof WorkerHealth['capabilities'],
): Promise<string | null> {
  const health = await workerHealth(config);
  if (health === null) return `сервер ${config.server.host}:${config.server.worker_port} не отвечает`;
  if (!health.capabilities[capability]) return `на сервере не установлено нужное для этой стадии (${capability})`;
  return null;
}

/** Название видеокарты сервера для журнала и отчёта. */
export function serverTitle(config: DubConfig, health: WorkerHealth | null): string {
  const gpu = health?.gpu?.name;
  return `сервер ${config.server.host}${gpu ? `, ${gpu}` : ''}`;
}

export interface WorkerJobResult {
  job: string;
  seconds: number;
  result: unknown;
  files: Record<string, string>;
  /**
   * Сервер считал на процессоре, а не на видеокарте: не хватило памяти или
   * драйвер отказал. Скрипты не падают в таком случае, а честно считают
   * медленнее — и человек должен об этом узнать, а не гадать, почему долго.
   */
  onCpu: boolean;
}

/** Строка журнала скрипта, которой он сообщает об откате на процессор. */
export function saysCpuFallback(text: string): boolean {
  return /считаю на процессоре|out of memory/i.test(text);
}

export interface WorkerJobOptions {
  /** Ход работы в процентах. */
  onProgress?: (percent: number) => void;
  /** Строки журнала скрипта на сервере. */
  onLog?: (text: string) => void;
  /** Лишние заголовки: токен Hugging Face для первой загрузки весов. */
  headers?: Record<string, string>;
}

/**
 * Отдаёт задачу сервису и ждёт результата.
 *
 * Файл уходит потоком, без чтения в память (дорожка фильма — сотни мегабайт),
 * ответ приходит строками JSON по мере работы. Остановка прогона обрывает
 * соединение, и сервис, заметив это, снимает расчёт с видеокарты.
 */
export async function runWorkerJob(
  config: DubConfig,
  kind: 'asr' | 'diarize' | 'separate',
  params: Record<string, string>,
  inputPath: string,
  options: WorkerJobOptions = {},
): Promise<WorkerJobResult> {
  const base = workerUrl(config);
  if (base === null) throw new Error('сервер не задан');
  const query = new URLSearchParams(params);
  if (config.server.free_gpu_memory) query.set('free', '1');
  // Дорожки обратно — во FLAC: вдвое меньше WAV, а сеть и есть узкое место.
  query.set('out', 'flac');
  const size = statSync(inputPath).size;
  const signal = cancellation.signal;
  signal?.throwIfAborted();

  return await new Promise<WorkerJobResult>((resolve, reject) => {
    let settled = false;
    let onCpu = false;
    const finish = (error: Error | null, value?: WorkerJobResult) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value!);
    };

    const req = http.request(`${base}/v1/${kind}?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), ...options.headers },
      signal: signal ?? undefined,
    });
    // Пока идёт расчёт, сервис шлёт «alive» раз в пять секунд; минута тишины — связь потеряна.
    req.setTimeout(120_000, () => req.destroy(new Error('сервер замолчал на две минуты')));
    req.on('error', (error) => {
      finish(signal?.aborted ? new CancelledError() : new Error(`связь с сервером: ${error.message}`));
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let reason = text.slice(0, 300);
          try {
            reason = (JSON.parse(text) as { error?: string }).error ?? reason;
          } catch {
            // не JSON — оставляем как есть
          }
          finish(new Error(`сервер ответил ${res.statusCode}: ${reason}`));
        });
        return;
      }
      const lines = createInterface({ input: res });
      lines.on('line', (line) => {
        if (!line.trim()) return;
        let event: { event?: string; percent?: number; text?: string; error?: string } & Partial<WorkerJobResult>;
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          return;
        }
        switch (event.event) {
          case 'progress':
            if (typeof event.percent === 'number') options.onProgress?.(event.percent);
            break;
          case 'queued':
            options.onLog?.('ждёт очереди на видеокарте сервера');
            break;
          case 'log':
            if (event.text) {
              if (saysCpuFallback(event.text)) onCpu = true;
              options.onLog?.(event.text);
            }
            break;
          case 'error':
            finish(new Error(event.error ?? 'сервер не выполнил задачу'));
            break;
          case 'done':
            finish(null, {
              job: event.job ?? '',
              seconds: event.seconds ?? 0,
              result: event.result ?? null,
              files: event.files ?? {},
              onCpu,
            });
            break;
          default:
            break;
        }
      });
      lines.on('close', () => finish(new Error('сервер закрыл соединение, не закончив задачу')));
    });

    const upload = createReadStream(inputPath);
    upload.on('error', (error) => req.destroy(error));
    upload.pipe(req);
  });
}

/** Забирает файл-результат задачи. Пишется через временное имя: обрыв не оставит половину. */
export async function fetchWorkerFile(config: DubConfig, file: string, target: string): Promise<void> {
  const base = workerUrl(config);
  if (base === null) throw new Error('сервер не задан');
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await new Promise<void>((resolve, reject) => {
    const req = http.get(`${base}${file}`, { signal: cancellation.signal ?? undefined }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`сервер не отдал ${file}: ${res.statusCode}`));
        return;
      }
      pipeline(res, createWriteStream(partial)).then(resolve, reject);
    });
    req.setTimeout(120_000, () => req.destroy(new Error('сервер замолчал при передаче файла')));
    req.on('error', reject);
  });
  await rename(partial, target);
}

/** Убирает файлы задачи на сервере; неудача не важна — их уберёт сам сервис через три часа. */
export async function dropWorkerJob(config: DubConfig, job: string): Promise<void> {
  const base = workerUrl(config);
  if (base === null || !job) return;
  try {
    await request(`${base}/v1/jobs/${job}`, { method: 'DELETE', timeoutMs: 5000 });
  } catch {
    // не страшно
  }
}

/** Синтез одной реплики на сервере; возвращает WAV. */
export async function workerSpeech(
  config: DubConfig,
  body: { model: string; url: string; naming: string; voice: string; text: string; sample_rate: number },
): Promise<Buffer> {
  const base = workerUrl(config);
  if (base === null) throw new Error('сервер не задан');
  const payload = JSON.stringify({ ...body, free: config.server.free_gpu_memory });
  const { status, body: reply } = await request(`${base}/v1/tts`, {
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    // Первая реплика ждёт загрузки модели на сервере, в том числе скачивания.
    timeoutMs: 600_000,
    signal: cancellation.signal,
  });
  if (status !== 200) {
    let reason = reply.toString('utf8').slice(0, 300);
    try {
      reason = (JSON.parse(reason) as { error?: string }).error ?? reason;
    } catch {
      // не JSON
    }
    throw new Error(reason);
  }
  return reply;
}

/**
 * Кладёт образец голоса на сервер, если его там ещё нет, и возвращает ключ.
 *
 * Ключ — хеш содержимого: один и тот же образец не перекачивается при каждом
 * прогоне, а другой (человек выбрал иную реплику) никогда не спутается с ним.
 */
export async function ensureCloneRef(config: DubConfig, file: string): Promise<string> {
  const base = workerUrl(config);
  if (base === null) throw new Error('сервер не задан');
  const audio = await readFile(file);
  const key = createHash('sha256').update(audio).digest('hex');
  const exists = await request(`${base}/v1/clone/ref/${key}`, { timeoutMs: 10_000 });
  if (exists.status === 200) return key;
  const { status, body } = await request(`${base}/v1/clone/ref/${key}`, {
    method: 'PUT',
    body: audio,
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(audio.length) },
    timeoutMs: 60_000,
  });
  if (status !== 200) throw new Error(`сервер не принял образец голоса: ${body.toString('utf8').slice(0, 200)}`);
  return key;
}

export interface CloneRequest {
  /** Ключ образца, полученный от `ensureCloneRef`. */
  ref: string;
  /** Что сказано в образце, на языке оригинала. */
  ref_text: string;
  ref_lang: string;
  /** Русский текст реплики. */
  text: string;
  /** Длина реплики, секунд: её выбрала подгонка. */
  duration: number;
  steps: number;
  /** Распознать готовый клип и вернуть услышанное — для проверки реплики. */
  check?: boolean;
}

export interface CloneResult {
  audio: Buffer;
  /** Что распознавание услышало в клипе; `null` — сервер не проверял. */
  heard: string | null;
}

/** Реплика голосом актёра; возвращает WAV. */
export async function cloneSpeech(config: DubConfig, body: CloneRequest): Promise<CloneResult> {
  const base = workerUrl(config);
  if (base === null) throw new Error('сервер не задан');
  const payload = JSON.stringify({ ...body, free: config.server.free_gpu_memory });
  const { status, body: reply, headers } = await request(`${base}/v1/clone`, {
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    // Первая реплика ждёт, пока мост поднимет модель: десятки секунд.
    timeoutMs: 600_000,
    signal: cancellation.signal,
  });
  if (status !== 200) {
    let reason = reply.toString('utf8').slice(0, 300);
    try {
      reason = (JSON.parse(reason) as { error?: string }).error ?? reason;
    } catch {
      // не JSON
    }
    throw new CloneError(reason, status);
  }
  const heard = headers['x-heard'];
  return { audio: reply, heard: typeof heard === 'string' ? decodeURIComponent(heard) : null };
}

/** Отказ сервера озвучить реплику. `status` 0 — до сервера не дошли вовсе. */
export class CloneError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CloneError';
  }
}

/**
 * Просит сервер освободить видеопамять под языковую модель: ComfyUI держит
 * последние модели в памяти карты, и Ollama тогда считает на процессоре.
 * Генерацию, которая идёт прямо сейчас, сервис не трогает.
 */
export async function freeServerGpu(config: DubConfig): Promise<string | null> {
  const base = workerUrl(config);
  if (base === null || !config.server.free_gpu_memory) return null;
  try {
    const { status, body } = await request(`${base}/v1/free`, { method: 'POST', timeoutMs: 40_000 });
    if (status !== 200) return null;
    return (JSON.parse(body.toString('utf8')) as { reason?: string }).reason ?? null;
  } catch {
    return null;
  }
}

/**
 * Сжимает звук во FLAC перед отправкой на сервер: без потерь и вдвое меньше.
 * `extra` — пересчёт по дороге, например в 44.1 кГц стерео для разделения.
 */
export async function packForServer(ffmpeg: string, source: string, target: string, extra: string[] = []): Promise<string> {
  await run(ffmpeg, ['-y', '-v', 'error', '-i', source, ...extra, '-c:a', 'flac', target], { timeoutMs: 1_800_000 });
  return target;
}

/** Файл-результат на месте и не пустой. */
export function received(target: string): boolean {
  return existsSync(target) && statSync(target).size > 0;
}

/** Удалить временный файл, не споря с тем, что его уже нет. */
export async function discard(target: string): Promise<void> {
  await rm(target, { force: true });
}
