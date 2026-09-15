import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DownloadError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { progress } from '../core/progress.js';
import { run } from './exec.js';
import { requireTool } from './tools.js';

/**
 * Работа с yt-dlp: разбор ссылки до загрузки, сама загрузка, человеческие ошибки.
 *
 * Отдельный модуль, а не код внутри S1, по трём причинам:
 *  - разбор ссылки нужен интерфейсу задолго до стадии — показать название,
 *    длительность и размер до того, как человек запустит часы работы и платный
 *    перевод;
 *  - `dub fetch` скачивает вообще без конвейера;
 *  - проценты, скорость и ETA — это разбор вывода yt-dlp, который проверяется
 *    тестами без сети. Внутри стадии, завязанной на файлы, он не проверялся бы
 *    вовсе.
 *
 * Все внешние вызовы идут через `run`, то есть массивом аргументов и без
 * оболочки: ссылки и имена файлов приходят от пользователя.
 */

/** Качество загрузки. Порог, а не точное разрешение: ровно 1080 дорожки есть не всегда. */
export const DOWNLOAD_QUALITIES = ['audio', '480p', '720p', '1080p', 'best'] as const;
export type DownloadQuality = (typeof DOWNLOAD_QUALITIES)[number];

/** Имя файла по умолчанию: название плюс id в скобках, чтобы одноимённое различалось. */
export const DEFAULT_FILENAME_TEMPLATE = '%(title)s [%(id)s].%(ext)s';

/** Расширения итоговых файлов: по ним отбирается результат среди появившихся. */
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4a', '.mp3', '.opus', '.aac', '.wav', '.flac']);

/**
 * Префикс строк прогресса в stdout.
 *
 * yt-dlp печатает полосу в stdout, а наши события прогресса идут в шину; префикс
 * отделяет одно от другого. `--progress-delta 1` обязателен: без него yt-dlp
 * сыплет строками каждые 100 мс, и это тысячи событий в SSE.
 *
 * Замер на встроенной версии 2026.08.19 (ролик 1.8 МБ, дорожки видео и звука):
 * `downloaded_bytes` растёт, `total_bytes_estimate` и `eta` иногда `NA`,
 * `total_bytes` появляется только на последней строке дорожки, `status` равен
 * `downloading` и `finished`. Отсюда вся арифметика ниже.
 */
export const PROGRESS_PREFIX = 'PROG|';
const PROGRESS_TEMPLATE =
  `${PROGRESS_PREFIX}d=%(progress.downloaded_bytes)s|t=%(progress.total_bytes_estimate)s|` +
  'ts=%(progress.total_bytes)s|s=%(progress.speed)s|eta=%(progress.eta)s|st=%(progress.status)s';

/** Один ролик в плейлисте: то, что показывают списком с галочками. */
export interface YtEntry {
  id: string;
  url: string;
  title: string;
  durationSeconds: number | null;
}

/** Разобранная ссылка: всё, что нужно карточке перед загрузкой и самой загрузке. */
export interface YtInfo {
  id: string;
  url: string;
  title: string;
  uploader: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  isLive: boolean;
  isPlaylist: boolean;
  entries: YtEntry[];
  /** Разрешение и ожидаемый размер для выбранного качества; null — неизвестно. */
  height: number | null;
  bytes: number | null;
}

export interface DownloadOptions {
  quality: DownloadQuality;
  container: string;
  filenameTemplate: string;
  /** `1-5,8` — элементы плейлиста; без него берётся только одно видео. */
  playlistItems?: string;
  /** Разрешить загрузку всего плейлиста, а не только ролика из ссылки. */
  playlist?: boolean;
  cookiesFromBrowser?: string | null;
  cookiesFile?: string | null;
  writeThumbnail?: boolean;
  writeSubtitles?: boolean;
  subtitleLanguages?: string[];
  concurrentFragments?: number;
  /** Сколько ждать всю загрузку. Час для трёхчасового фильма на медленном канале — мало. */
  timeoutMs?: number;
  /** Ожидаемый размер из разбора: по нему считается процент. */
  expectedBytes?: number | null;
  /** Идентификатор ролика: по нему находится уже скачанное. */
  videoId?: string;
  /** Метка для шины прогресса, обычно название ролика. */
  label?: string;
}

/** Состояние разбора между строками: дорожки идут по очереди, байты копятся. */
export interface ProgressState {
  finishedBytes: number;
  previousBytes: number;
}

export interface ProgressSample {
  downloadedBytes: number;
  totalBytes: number | null;
  speedBytesPerSecond: number | null;
  etaSeconds: number | null;
  finished: boolean;
}

/** Разбор `NA` и мусора: yt-dlp пишет `NA`, когда величина неизвестна. */
function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'NA') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Одна строка прогресса → сколько уже скачано.
 *
 * Дорожек две (видео и звук), и `downloaded_bytes` каждой начинается с нуля.
 * Поэтому байты складываются: завершённые дорожки плюс текущая. Новая дорожка
 * узнаётся по падению счётчика — другого признака в выводе нет, а `total_bytes`
 * появляется лишь на последней строке.
 */
export function parseProgressLine(
  line: string,
  state: ProgressState,
  expectedBytes: number | null,
): ProgressSample | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  const fields = new Map<string, string>();
  for (const pair of line.slice(PROGRESS_PREFIX.length).split('|')) {
    const at = pair.indexOf('=');
    if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
  }

  const downloaded = toNumber(fields.get('d'));
  if (downloaded === null) return null;

  if (state.previousBytes > 0 && downloaded < state.previousBytes) {
    state.finishedBytes += state.previousBytes;
  }
  state.previousBytes = downloaded;

  const speed = toNumber(fields.get('s'));
  const received = state.finishedBytes + downloaded;
  const total = expectedBytes ?? null;
  // ETA считаем по всему файлу, а не по дорожке: полоса одна на загрузку.
  const eta = total !== null && speed && speed > 0 ? (total - received) / speed : toNumber(fields.get('eta'));

  return {
    downloadedBytes: received,
    totalBytes: total,
    speedBytesPerSecond: speed,
    etaSeconds: eta !== null && eta >= 0 ? eta : null,
    finished: fields.get('st') === 'finished',
  };
}

/** Селектор дорожек для yt-dlp: порог по высоте, лучшее качество или только звук. */
export function formatSelector(quality: DownloadQuality): string {
  if (quality === 'audio') {
    // m4a первым: он открывается везде, без перекодирования и без ffmpeg.
    return 'ba[ext=m4a]/ba/b';
  }
  if (quality === 'best') return 'bv*+ba/b';
  const height = Number(quality.replace('p', ''));
  return `bv*[height<=${height}]+ba/b[height<=${height}]/b`;
}

interface RawFormat {
  format_id?: string;
  ext?: string;
  height?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
}

interface RawInfo {
  _type?: string;
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  webpage_url?: string;
  url?: string;
  duration?: number;
  is_live?: boolean;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
  formats?: RawFormat[];
  entries?: RawInfo[];
}

function sizeOf(format: RawFormat): number | null {
  return format.filesize ?? format.filesize_approx ?? null;
}

/** Лучшая дорожка среди подходящих: чем выше разрешение, тем лучше. */
function bestFormat(formats: RawFormat[], predicate: (format: RawFormat) => boolean): RawFormat | null {
  let chosen: RawFormat | null = null;
  let chosenScore = -1;
  for (const format of formats) {
    if (!predicate(format)) continue;
    const score = format.height ?? 0;
    if (score >= chosenScore) {
      chosen = format;
      chosenScore = score;
    }
  }
  return chosen;
}

/**
 * Разрешение и ожидаемый размер для выбранного качества.
 *
 * Размер приблизительный: точный yt-dlp сообщает не всегда, а складывать
 * размеры двух дорожек — единственный способ получить осмысленное «480 МБ» в
 * карточке до загрузки. Когда размер неизвестен, честнее вернуть null: полоса
 * тогда будет без процентов, а не с выдуманным числом.
 */
export function estimateDownload(
  formats: RawFormat[],
  quality: DownloadQuality,
): { height: number | null; bytes: number | null } {
  const isAudioOnly = (format: RawFormat): boolean =>
    (format.acodec ?? 'none') !== 'none' && (format.vcodec ?? 'none') === 'none';
  const isVideoOnly = (format: RawFormat): boolean =>
    (format.vcodec ?? 'none') !== 'none' && (format.acodec ?? 'none') === 'none';
  const isMuxed = (format: RawFormat): boolean =>
    (format.vcodec ?? 'none') !== 'none' && (format.acodec ?? 'none') !== 'none';

  const audio = bestFormat(formats, isAudioOnly);
  if (quality === 'audio') {
    return { height: null, bytes: audio ? sizeOf(audio) : null };
  }

  const limit = quality === 'best' ? Number.POSITIVE_INFINITY : Number(quality.replace('p', ''));
  const video = bestFormat(formats, (format) => isVideoOnly(format) && (format.height ?? 0) <= limit);
  if (!video) {
    const muxed = bestFormat(formats, isMuxed);
    return { height: muxed?.height ?? null, bytes: muxed ? sizeOf(muxed) : null };
  }

  const videoSize = sizeOf(video);
  const audioSize = audio ? sizeOf(audio) : null;
  return {
    height: video.height ?? null,
    bytes: videoSize !== null && audioSize !== null ? videoSize + audioSize : null,
  };
}

function normalizeEntry(entry: RawInfo): YtEntry {
  return {
    id: entry.id ?? '',
    url: entry.webpage_url ?? entry.url ?? '',
    title: entry.title ?? '(без названия)',
    durationSeconds: entry.duration ?? null,
  };
}

/**
 * Разбор ссылки без загрузки: `-J` печатает метаданные в stdout.
 *
 * `--flat-playlist` не разворачивает плейлист в полные метаданные — для списка
 * с галочками хватает идентификаторов, названий и длительностей, а формат и
 * размер каждая загрузка всё равно выбирает сама.
 */
export async function resolveYt(
  url: string,
  toolsDir: string,
  quality: DownloadQuality = '1080p',
): Promise<YtInfo> {
  const ytDlp = await requireTool('yt-dlp', toolsDir);
  log.debug(`разбор ссылки: ${url}`);

  const { stdout } = await run(ytDlp, ['-J', '--flat-playlist', '--skip-download', '--no-warnings', url], {
    timeoutMs: 180_000,
    captureStdout: true,
  });

  let raw: RawInfo;
  try {
    raw = JSON.parse(stdout) as RawInfo;
  } catch {
    throw new DownloadError('Не удалось разобрать ответ yt-dlp: это не JSON', [
      'Проверьте, что ссылка ведёт на видео, а не на страницу сайта',
    ]);
  }
  return parseYtJson(raw, url, quality);
}

/**
 * Метаданные в разобранный вид.
 *
 * Отдельной функцией, потому что разбор — единственное место, где легко
 * ошибиться в полях: yt-dlp называет канал то `uploader`, то `channel`, у
 * плейлиста нет форматов, у прямого эфира нет длительности.
 */
export function parseYtJson(input: unknown, url: string, quality: DownloadQuality = '1080p'): YtInfo {
  const raw = (input ?? {}) as RawInfo;
  if (raw._type === 'playlist') {
    const entries = (raw.entries ?? []).map(normalizeEntry);
    const total = entries.reduce((sum, entry) => sum + (entry.durationSeconds ?? 0), 0);
    return {
      id: raw.id ?? '',
      url,
      title: raw.title ?? 'Плейлист',
      uploader: raw.uploader ?? raw.channel ?? null,
      durationSeconds: total > 0 ? total : null,
      thumbnailUrl: raw.thumbnail ?? raw.thumbnails?.[0]?.url ?? null,
      isLive: false,
      isPlaylist: true,
      entries,
      height: null,
      bytes: null,
    };
  }

  const estimate = estimateDownload(raw.formats ?? [], quality);
  return {
    id: raw.id ?? '',
    url: raw.webpage_url ?? url,
    title: raw.title ?? '(без названия)',
    uploader: raw.uploader ?? raw.channel ?? null,
    durationSeconds: raw.duration ?? null,
    thumbnailUrl: raw.thumbnail ?? raw.thumbnails?.[0]?.url ?? null,
    isLive: raw.is_live === true,
    isPlaylist: false,
    entries: [],
    height: estimate.height,
    bytes: estimate.bytes,
  };
}

/** Что осталось в каталоге после прерванной загрузки. */
function looksPartial(name: string): boolean {
  return name.endsWith('.part') || name.endsWith('.ytdl') || /\.f\d+\./.test(name);
}

/** Снимок каталога до загрузки: по нему потом видно, что появилось. */
export async function snapshotDir(dir: string): Promise<Map<string, number>> {
  return await listFiles(dir);
}

async function listFiles(dir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!existsSync(dir)) return result;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const info = await stat(path.join(dir, entry.name));
    result.set(entry.name, info.size);
  }
  return result;
}

/**
 * Уборка после отмены.
 *
 * Windows-замер это и показал: после убийства процесса остаются не только
 * `*.part`, но и промежуточные дорожки `video.f396.mp4` / `audio.f251.webm`, а
 * `*.part` ещё и держится процессом — повтор с докачкой падает на переименовании
 * с `WinError 32`. Поэтому отмена убирает всё, что появилось за время загрузки,
 * и следующий запуск начинает с чистого листа.
 */
export async function removePartialArtifacts(dir: string, before: Map<string, number>): Promise<void> {
  const after = await listFiles(dir);
  for (const [name, size] of after) {
    const appeared = !before.has(name) || before.get(name) !== size;
    if (!appeared) continue;
    if (!looksPartial(name)) continue;
    await rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

/** Итоговые файлы: появившиеся за время загрузки плюс уже лежавший ролик. */
export async function collectDownloadResults(
  dir: string,
  before: Map<string, number>,
  videoId: string | undefined,
): Promise<string[]> {
  const after = await listFiles(dir);
  const media = (name: string): boolean => MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase()) && !looksPartial(name);

  const appeared = [...after.keys()].filter((name) => media(name) && !before.has(name));
  if (appeared.length > 0) {
    const timed = await Promise.all(
      appeared.map(async (name) => ({ name, at: (await stat(path.join(dir, name))).mtimeMs })),
    );
    timed.sort((left, right) => left.at - right.at);
    return timed.map((item) => path.join(dir, item.name));
  }
  // Файл уже был на месте: yt-dlp сказал «has already been downloaded».
  if (videoId) {
    const existing = [...after.keys()].filter((name) => media(name) && name.includes(videoId));
    if (existing.length > 0) return existing.map((name) => path.join(dir, name));
  }
  return [];
}

export function buildYtArgs(
  ffmpegDir: string,
  url: string,
  options: DownloadOptions,
  template: string,
): string[] {
  const args = [
    '--newline',
    '--no-warnings',
    '--progress-delta',
    '1',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--ffmpeg-location',
    ffmpegDir,
    '--continue',
    '-o',
    template,
    '-f',
    formatSelector(options.quality),
  ];

  if (options.playlistItems) {
    args.push('-I', options.playlistItems);
  } else if (!options.playlist) {
    args.push('--no-playlist');
  }
  if (options.quality !== 'audio') {
    args.push('--merge-output-format', options.container);
  }
  if (options.cookiesFromBrowser) args.push('--cookies-from-browser', options.cookiesFromBrowser);
  if (options.cookiesFile) args.push('--cookies', options.cookiesFile);
  if (options.writeThumbnail) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  if (options.writeSubtitles) {
    args.push(
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      (options.subtitleLanguages ?? ['en']).join(','),
      '--convert-subs',
      'srt',
    );
  }
  if (options.concurrentFragments && options.concurrentFragments > 1) {
    args.push('--concurrent-fragments', String(options.concurrentFragments));
  }
  args.push('--', url);
  return args;
}

/**
 * Скачать видео или звук в каталог.
 *
 * Возвращает пути к итоговым файлам: у одного ролика он один, у плейлиста —
 * столько, сколько было скачано. Прогресс идёт в шину событием `download`,
 * поэтому интерфейс и CLI показывают одно и то же.
 */
export async function downloadYt(
  url: string,
  targetDir: string,
  toolsDir: string,
  options: DownloadOptions,
): Promise<string[]> {
  const ytDlp = await requireTool('yt-dlp', toolsDir);
  const ffmpegDir = path.dirname(await requireTool('ffmpeg', toolsDir));
  await mkdir(targetDir, { recursive: true });

  const template = path.join(targetDir, options.filenameTemplate || DEFAULT_FILENAME_TEMPLATE);
  const progressId = `download:${options.label ?? url}`;
  const label = options.label ?? 'видео';
  const before = await snapshotDir(targetDir);
  const state: ProgressState = { finishedBytes: 0, previousBytes: 0 };
  const expected = options.expectedBytes ?? null;

  progress.emit({ id: progressId, kind: 'download', label, status: 'running', percent: null, detail: 'загрузка' });

  try {
    await run(ytDlp, buildYtArgs(ffmpegDir, url, options, template), {
      timeoutMs: options.timeoutMs ?? 6 * 3_600_000,
      onStdout: (chunk) => {
        for (const raw of chunk.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          const sample = parseProgressLine(line, state, expected);
          if (!sample) {
            // Сведение дорожек идёт после загрузки и молчит: без этой строки
            // полоса выглядела бы замершей.
            if (line.includes('[Merger]')) {
              progress.emit({
                id: progressId,
                kind: 'download',
                label,
                status: 'running',
                percent: null,
                detail: 'сведение дорожек',
              });
            }
            continue;
          }
          const percent =
            sample.totalBytes && sample.totalBytes > 0
              ? Math.min(99, Math.round((sample.downloadedBytes / sample.totalBytes) * 100))
              : null;
          progress.emit({
            id: progressId,
            kind: 'download',
            label,
            status: 'running',
            percent,
            receivedBytes: sample.downloadedBytes,
            ...(sample.totalBytes !== null ? { totalBytes: sample.totalBytes } : {}),
            detail: sample.etaSeconds !== null ? `осталось ${Math.round(sample.etaSeconds)} с` : 'загрузка',
          });
        }
      },
      onStderr: (chunk) => log.debug(chunk.trim()),
    });
  } catch (error) {
    await removePartialArtifacts(targetDir, before);
    progress.emit({ id: progressId, kind: 'download', label, status: 'error', percent: null });
    if (error instanceof Error && !(error instanceof DownloadError)) {
      throw classifyYtError((error as { stderr?: string }).stderr ?? error.message);
    }
    throw error;
  }

  const files = await collectDownloadResults(targetDir, before, options.videoId);
  if (files.length === 0) {
    progress.emit({ id: progressId, kind: 'download', label, status: 'error', percent: null });
    throw new DownloadError('yt-dlp завершился успешно, но файла в папке нет', [
      `Проверьте права на запись в ${targetDir}`,
    ]);
  }

  progress.emit({ id: progressId, kind: 'download', label, status: 'done', percent: 100 });
  return files;
}

/**
 * Ошибка yt-dlp человеческим языком.
 *
 * Без этого «Sign in to confirm you're not a bot», «Video unavailable» и
 * «Requested format is not available» выглядят одинаково — хвостом stderr, из
 * которого непонятно, что делать. Подсказка важнее текста ошибки: за ней и
 * приходят.
 */
export function classifyYtError(stderr: string): DownloadError {
  const text = stderr.toLowerCase();

  if (text.includes('sign in to confirm') || text.includes('not a bot')) {
    return new DownloadError('YouTube требует вход: «подтвердите, что вы не робот»', [
      'Запустите с куками браузера: dub fetch <ссылка> --cookies-from-browser chrome',
      'Либо задайте download.cookies_from_browser в config.yaml',
    ]);
  }
  if (text.includes('private video')) {
    return new DownloadError('Видео приватное — доступ есть только у владельца', [
      'Откройте его в браузере и укажите DubPipe путь к файлу',
    ]);
  }
  if (text.includes('members-only') || text.includes('join this channel')) {
    return new DownloadError('Видео только для участников канала', [
      'Нужны куки аккаунта с подпиской: --cookies-from-browser <браузер>',
    ]);
  }
  if (text.includes('age') && text.includes('restricted')) {
    return new DownloadError('Видео с возрастным ограничением', [
      'Сработает вход через куки браузера: --cookies-from-browser <браузер>',
    ]);
  }
  if (text.includes('video unavailable') || text.includes('removed by the uploader')) {
    return new DownloadError('Видео недоступно: удалено или скрыто автором', [
      'Если ссылка открывается в браузере, обновите загрузчик: dub tools update yt-dlp',
    ]);
  }
  if (text.includes('not available in your country')) {
    return new DownloadError('Видео недоступно в вашем регионе', [
      'Ограничение на стороне YouTube; средств обхода DubPipe не предоставляет',
    ]);
  }
  if (text.includes('requested format is not available')) {
    return new DownloadError('Запрошенное качество недоступно для этого видео', [
      'Другой вариант: download.quality: best в config.yaml',
      'Список дорожек: dub fetch <ссылка> --list-formats',
    ]);
  }
  if (text.includes('unable to download webpage') || text.includes('urlopen error') || text.includes('getaddrinfo')) {
    return new DownloadError('Не удалось связаться с YouTube — похоже, нет сети', [
      'Проверьте подключение и повторите: скачанное ранее не потеряется',
    ]);
  }
  if (text.includes('unable to rename file') || text.includes('winerror 32')) {
    return new DownloadError('Файл занят другим процессом — загрузка не смогла сохраниться', [
      'Закройте проигрыватель и повторите: недокачанные файлы уже удалены',
    ]);
  }

  const tail = stderr.trim().split('\n').slice(-4).join('\n');
  return new DownloadError(`yt-dlp не смог скачать видео${tail ? `:\n${tail}` : ''}`, [
    'Обновить yt-dlp: dub tools update yt-dlp',
  ]);
}

/** Одна дорожка для `dub fetch --list-formats`. */
export interface YtFormatRow {
  formatId: string;
  ext: string;
  height: number | null;
  vcodec: string;
  acodec: string;
  bytes: number | null;
}

/**
 * Все дорожки ролика.
 *
 * Отдельный вызов, а не поле в `YtInfo`: разбор ссылки идёт на каждый запуск и
 * обязан быть дешёвым, а полный список дорожек нужен только тому, кто просит.
 */
export async function listFormats(url: string, toolsDir: string): Promise<YtFormatRow[]> {
  const ytDlp = await requireTool('yt-dlp', toolsDir);
  const { stdout } = await run(ytDlp, ['-J', '--skip-download', '--no-warnings', '--no-playlist', url], {
    timeoutMs: 180_000,
    captureStdout: true,
  });

  let raw: RawInfo;
  try {
    raw = JSON.parse(stdout) as RawInfo;
  } catch {
    throw new DownloadError('Не удалось разобрать ответ yt-dlp: это не JSON', [
      'Проверьте, что ссылка ведёт на видео',
    ]);
  }

  return (raw.formats ?? [])
    // Раскадровки (`sb0`, `sb1`, mhtml) — не дорожки: ни видео, ни звука в них нет.
    .filter((format) => (format.vcodec ?? 'none') !== 'none' || (format.acodec ?? 'none') !== 'none')
    .map((format) => ({
      formatId: format.format_id ?? '?',
      ext: format.ext ?? '?',
      height: format.height ?? null,
      vcodec: format.vcodec ?? 'none',
      acodec: format.acodec ?? 'none',
      bytes: sizeOf(format),
    }))
    // Сверху — то, что человек ищет: высокое разрешение, затем крупные дорожки.
    .sort((left, right) => (right.height ?? 0) - (left.height ?? 0) || (right.bytes ?? 0) - (left.bytes ?? 0));
}

/**
 * Сколько дней версия yt-dlp считается свежей.
 *
 * Замер по истории: YouTube ломает разбор несколько раз в год, а встроенная
 * копия качается один раз при установке и больше не обновляется. Полтора месяца —
 * компромисс между «дёргать по любому поводу» и «молчать, пока всё не отвалится».
 */
export const YTDLP_MAX_AGE_DAYS = 45;

/**
 * Устарел ли загрузчик.
 *
 * Версия yt-dlp — это дата выпуска (`2026.08.19`), поэтому возраст считается по
 * ней, без обращения к сети. Непонятный формат версии — не повод пугать
 * пользователя: считаем свежей.
 */
export function isYtDlpStale(version: string, now: Date = new Date(), maxAgeDays = YTDLP_MAX_AGE_DAYS): boolean {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version.trim());
  if (!match) return false;
  const released = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(released.getTime())) return false;
  const days = (now.getTime() - released.getTime()) / 86_400_000;
  return days > maxAgeDays;
}

/** Версия yt-dlp: по ней видно, не устарел ли встроенный загрузчик. */
export async function ytDlpVersion(toolsDir: string): Promise<string | null> {
  try {
    const ytDlp = await requireTool('yt-dlp', toolsDir);
    const { stdout } = await run(ytDlp, ['--version'], { timeoutMs: 30_000, captureStdout: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
