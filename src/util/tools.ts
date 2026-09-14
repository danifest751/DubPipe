import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { MissingDependencyError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { run } from './exec.js';
import { downloadFile } from './download.js';

/**
 * Locating and provisioning external binaries (SPEC §8, §15.3). A tool already
 * present in PATH wins; otherwise it is fetched into <cache.dir>/tools, which
 * needs no administrator rights and no system-wide install.
 */

export type ToolName = 'ffmpeg' | 'ffprobe' | 'yt-dlp' | 'whisper-cli' | 'piper';

const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';

export interface ToolSpec {
  name: ToolName;
  /** Executable name as it would appear in PATH. */
  binary: string;
  /**
   * Ключ загрузки. ffmpeg и ffprobe приходят одним архивом, и при параллельном
   * провижининге оба вызвали бы одну и ту же распаковку в общий каталог.
   * Одинаковый ключ означает «ждать ту же самую операцию».
   */
  fetchKey?: string;
  required: boolean;
  purpose: string;
  installHint: string;
  /** Path inside the tools dir once provisioned, relative to <tools>/<name>/. */
  localPath: string;
  fetch?: (toolsDir: string) => Promise<void>;
}

const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const YTDLP_URL = IS_WINDOWS
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const WHISPER_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-blas-bin-x64.zip';
const PIPER_ZIP = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

/** Extracts a zip using the platform's own tooling — no archive dependency. */
export async function unzip(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (IS_WINDOWS) {
    await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`,
      ],
      { timeoutMs: 300_000 },
    );
  } else {
    await run('unzip', ['-o', archive, '-d', destination], { timeoutMs: 300_000 });
  }
}

/** Finds a file by name anywhere under root (archives nest their own folder). */
export async function findUnder(root: string, fileName: string, depth = 4): Promise<string | null> {
  if (depth < 0 || !existsSync(root)) return null;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findUnder(path.join(root, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return null;
}

async function fetchFfmpegBundle(toolsDir: string): Promise<void> {
  if (!IS_WINDOWS) {
    throw new MissingDependencyError('ffmpeg', 'Автозагрузка ffmpeg поддерживается только для Windows', [
      'Linux:  sudo apt install ffmpeg',
      'macOS:  brew install ffmpeg',
    ]);
  }
  const staging = path.join(toolsDir, '.staging-ffmpeg');
  const archive = path.join(staging, 'ffmpeg.zip');
  await downloadFile(FFMPEG_ZIP, archive, { label: 'ffmpeg', minBytes: 10_000_000, timeoutMs: 600_000 });
  await unzip(archive, staging);

  const target = path.join(toolsDir, 'ffmpeg');
  await mkdir(target, { recursive: true });
  for (const binary of ['ffmpeg.exe', 'ffprobe.exe']) {
    const found = await findUnder(staging, binary);
    if (!found) throw new MissingDependencyError(binary, `В архиве ffmpeg не найден ${binary}`);
    await rename(found, path.join(target, binary));
  }
  await rm(staging, { recursive: true, force: true });
}

async function fetchYtDlp(toolsDir: string): Promise<void> {
  const target = path.join(toolsDir, 'yt-dlp', `yt-dlp${EXE}`);
  await downloadFile(YTDLP_URL, target, { label: 'yt-dlp', minBytes: 1_000_000, timeoutMs: 600_000 });
  if (!IS_WINDOWS) await chmod(target, 0o755);
}

async function fetchWhisperCpp(toolsDir: string): Promise<void> {
  if (!IS_WINDOWS) {
    throw new MissingDependencyError('whisper-cli', 'Автозагрузка whisper.cpp поддерживается только для Windows', [
      'Соберите из исходников: https://github.com/ggml-org/whisper.cpp',
    ]);
  }
  const staging = path.join(toolsDir, '.staging-whisper');
  const archive = path.join(staging, 'whisper.zip');
  await downloadFile(WHISPER_ZIP, archive, { label: 'whisper.cpp', minBytes: 5_000_000, timeoutMs: 600_000 });
  await unzip(archive, staging);

  const target = path.join(toolsDir, 'whisper');
  await mkdir(target, { recursive: true });
  // The BLAS build ships the CLI plus its DLLs; keep the whole folder together.
  const cli = (await findUnder(staging, 'whisper-cli.exe')) ?? (await findUnder(staging, 'main.exe'));
  if (!cli) throw new MissingDependencyError('whisper-cli', 'В архиве whisper.cpp не найден исполняемый файл');
  const sourceDir = path.dirname(cli);
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await rename(path.join(sourceDir, entry.name), path.join(target, entry.name));
  }
  if (path.basename(cli).toLowerCase() === 'main.exe') {
    await rename(path.join(target, 'main.exe'), path.join(target, 'whisper-cli.exe'));
  }
  await rm(staging, { recursive: true, force: true });
}

async function fetchPiper(toolsDir: string): Promise<void> {
  if (!IS_WINDOWS) {
    throw new MissingDependencyError('piper', 'Автозагрузка piper поддерживается только для Windows', [
      'Релизы для других платформ: https://github.com/rhasspy/piper/releases',
    ]);
  }
  const staging = path.join(toolsDir, '.staging-piper');
  const archive = path.join(staging, 'piper.zip');
  await downloadFile(PIPER_ZIP, archive, { label: 'piper', minBytes: 5_000_000, timeoutMs: 600_000 });
  await unzip(archive, staging);

  const exe = await findUnder(staging, 'piper.exe');
  if (!exe) throw new MissingDependencyError('piper', 'В архиве piper не найден piper.exe');
  const target = path.join(toolsDir, 'piper');
  await mkdir(target, { recursive: true });
  const sourceDir = path.dirname(exe);
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(target, entry.name);
    await rename(from, to).catch(() => undefined);
  }
  await rm(staging, { recursive: true, force: true });
}

export const TOOLS: Record<ToolName, ToolSpec> = {
  ffmpeg: {
    name: 'ffmpeg',
    binary: `ffmpeg${EXE}`,
    required: true,
    fetchKey: 'ffmpeg-bundle',
    purpose: 'извлечение аудио, темп, сведение, mux (S1, S6, S7)',
    installHint: IS_WINDOWS
      ? 'dub doctor --fetch  (или winget install Gyan.FFmpeg)'
      : 'apt install ffmpeg / brew install ffmpeg',
    localPath: path.join('ffmpeg', `ffmpeg${EXE}`),
    fetch: fetchFfmpegBundle,
  },
  ffprobe: {
    name: 'ffprobe',
    binary: `ffprobe${EXE}`,
    required: true,
    fetchKey: 'ffmpeg-bundle',
    purpose: 'определение длительности и наличия видеопотока (S1)',
    installHint: IS_WINDOWS
      ? 'dub doctor --fetch  (или winget install Gyan.FFmpeg)'
      : 'apt install ffmpeg / brew install ffmpeg',
    localPath: path.join('ffmpeg', `ffprobe${EXE}`),
    fetch: fetchFfmpegBundle,
  },
  'yt-dlp': {
    name: 'yt-dlp',
    binary: `yt-dlp${EXE}`,
    required: false,
    purpose: 'загрузка видео по YouTube-URL (S1)',
    installHint: 'dub doctor --fetch  (или winget install yt-dlp.yt-dlp)',
    localPath: path.join('yt-dlp', `yt-dlp${EXE}`),
    fetch: fetchYtDlp,
  },
  'whisper-cli': {
    name: 'whisper-cli',
    binary: `whisper-cli${EXE}`,
    required: false,
    purpose: 'локальное распознавание речи с таймкодами (S2)',
    installHint: 'dub doctor --fetch',
    localPath: path.join('whisper', `whisper-cli${EXE}`),
    fetch: fetchWhisperCpp,
  },
  piper: {
    name: 'piper',
    binary: `piper${EXE}`,
    required: false,
    purpose: 'локальный синтез русской речи (S5)',
    installHint: 'dub doctor --fetch',
    localPath: path.join('piper', `piper${EXE}`),
    fetch: fetchPiper,
  },
};

async function inPath(binary: string): Promise<string | null> {
  try {
    const probe = IS_WINDOWS ? 'where' : 'which';
    const { stdout } = await run(probe, [binary], { timeoutMs: 10_000 });
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

export interface ResolvedTool {
  name: ToolName;
  path: string;
  source: 'path' | 'local';
}

const resolveCache = new Map<string, ResolvedTool | null>();

/** Returns the usable path for a tool, or null when it is nowhere to be found. */
export async function findTool(name: ToolName, toolsDir: string): Promise<ResolvedTool | null> {
  const cacheKey = `${name}:${toolsDir}`;
  const cached = resolveCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const spec = TOOLS[name];
  const local = path.join(toolsDir, spec.localPath);
  let result: ResolvedTool | null = null;

  if (existsSync(local)) {
    result = { name, path: local, source: 'local' };
  } else {
    const fromPath = await inPath(spec.binary);
    if (fromPath) result = { name, path: fromPath, source: 'path' };
  }
  resolveCache.set(cacheKey, result);
  return result;
}

/** Like findTool, but throws the install instructions when absent (SPEC §8). */
export async function requireTool(name: ToolName, toolsDir: string): Promise<string> {
  const found = await findTool(name, toolsDir);
  if (found) return found.path;
  const spec = TOOLS[name];
  throw new MissingDependencyError(name, `Не найден ${spec.binary} — нужен для: ${spec.purpose}`, [
    `Установка: ${spec.installHint}`,
  ]);
}

/** Загрузки архивов, идущие прямо сейчас, по ключу архива. */
const provisioning = new Map<string, Promise<void>>();

/**
 * Downloads a tool into the workspace if it is not already available.
 *
 * Два правила, без которых ffmpeg и ffprobe ломали друг друга:
 *  - один архив даёт обе программы, и параллельный вызов для второй должен
 *    ждать уже идущую распаковку, а не запускать свою — вторая распаковка
 *    падала с EBUSY на файле, который двигала первая;
 *  - после распаковки сбрасывается весь кэш поиска, а не только запись этой
 *    программы: иначе соседняя по архиву остаётся «не найденной» и следующий
 *    вызов честно качает те же 106 МБ ещё раз.
 */
export async function provisionTool(name: ToolName, toolsDir: string): Promise<ResolvedTool> {
  const existing = await findTool(name, toolsDir);
  if (existing) return existing;
  const spec = TOOLS[name];
  if (!spec.fetch) {
    throw new MissingDependencyError(name, `Автозагрузка ${name} не поддерживается`, [`Установка: ${spec.installHint}`]);
  }

  const key = `${spec.fetchKey ?? name}:${toolsDir}`;
  let task = provisioning.get(key);
  if (!task) {
    log.info(`Провижининг ${spec.fetchKey ?? name}…`);
    task = spec.fetch(toolsDir).finally(() => provisioning.delete(key));
    provisioning.set(key, task);
  }
  await task;

  resetToolCache();
  const resolved = await findTool(name, toolsDir);
  if (!resolved) {
    throw new MissingDependencyError(name, `После загрузки ${name} всё ещё не найден в ${toolsDir}`);
  }
  return resolved;
}

export function resetToolCache(): void {
  resolveCache.clear();
}
