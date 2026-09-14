import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MissingDependencyError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { downloadFile } from '../../util/download.js';
import { run } from '../../util/exec.js';
import { findUnder, unzip } from '../../util/tools.js';

/**
 * Чем считать распознавание: процессором или видеокартой.
 *
 * whisper.cpp собирается под разные ускорители, и на одном и том же железе
 * разница велика: на Radeon 780M пятиминутный кусок распознаётся за 22 секунды
 * вместо 58 — в 2.6 раза быстрее при том же тексте на нормальной речи.
 *
 * Здесь только описание сборок и правило выбора. Загрузкой занимается
 * `util/tools.ts`, а конкретную сборку выбирает пользователь настройкой
 * `asr.backend` — или она выбирается сама по найденному железу.
 */

export type AccelId = 'cpu' | 'blas' | 'cuda' | 'vulkan';
export type AccelPreference = AccelId | 'auto';

/** Кто собрал архив. У официального проекта нет сборок под AMD вовсе. */
export interface BuildOrigin {
  name: string;
  url: string;
  /** Сборка из релизов самого whisper.cpp, а не третьей стороны. */
  official: boolean;
}

export interface AccelBuild {
  id: AccelId;
  /** Название для интерфейса и журнала. */
  title: string;
  url: string;
  version: string;
  minBytes: number;
  origin: BuildOrigin;
  /** Какое железо нужно, чтобы сборка вообще заработала. */
  requires: 'none' | 'nvidia' | 'gpu';
}

const GGML: BuildOrigin = {
  name: 'ggml-org/whisper.cpp',
  url: 'https://github.com/ggml-org/whisper.cpp/releases',
  official: true,
};

/**
 * Сборка с Vulkan — от команды Lemonade SDK: официальный проект whisper.cpp
 * под AMD не собирает ничего, и ждать этого не приходится. Поэтому она никогда
 * не выбирается сама: подключить чужой бинарник — осознанное решение человека.
 */
const LEMONADE: BuildOrigin = {
  name: 'lemonade-sdk/whisper.cpp',
  url: 'https://github.com/lemonade-sdk/whisper.cpp/releases',
  official: false,
};

const WHISPER_VERSION = 'v1.9.2';

export const ACCEL_BUILDS: Record<AccelId, AccelBuild> = {
  cpu: {
    id: 'cpu',
    title: 'процессор',
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`,
    version: WHISPER_VERSION,
    minBytes: 2_000_000,
    origin: GGML,
    requires: 'none',
  },
  blas: {
    id: 'blas',
    title: 'процессор с BLAS',
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-blas-bin-x64.zip`,
    version: WHISPER_VERSION,
    minBytes: 5_000_000,
    origin: GGML,
    requires: 'none',
  },
  cuda: {
    id: 'cuda',
    title: 'видеокарта NVIDIA (CUDA)',
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-cublas-12.4.0-bin-x64.zip`,
    version: WHISPER_VERSION,
    minBytes: 100_000_000,
    origin: GGML,
    requires: 'nvidia',
  },
  vulkan: {
    id: 'vulkan',
    title: 'видеокарта через Vulkan (AMD, Intel, NVIDIA)',
    url: 'https://github.com/lemonade-sdk/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64-vulkan.zip',
    version: 'v1.8.4',
    minBytes: 10_000_000,
    origin: LEMONADE,
    requires: 'gpu',
  },
};

export interface Hardware {
  /** Названия видеоадаптеров, как их сообщает система. */
  adapters: string[];
  nvidia: boolean;
  amd: boolean;
  intel: boolean;
}

/** Разбор названий видеоадаптеров — вся логика определения железа, без системных вызовов. */
export function classifyAdapters(adapters: string[]): Hardware {
  const all = adapters.join(' | ').toLowerCase();
  return {
    adapters,
    nvidia: /\bnvidia\b|geforce|quadro|\brtx\b|\bgtx\b/.test(all),
    amd: /\bamd\b|radeon|\bati\b/.test(all),
    // Встроенная графика Intel тоже умеет Vulkan, но отдельной сборки под неё нет.
    intel: /\bintel\b|\barc\b|\biris\b|\buhd graphics\b/.test(all),
  };
}

export type GpuKind = 'integrated' | 'discrete';

/**
 * Встроенная видеокарта или отдельная — по названию адаптера.
 *
 * Разница существенная: встроенная делит память и её пропускную способность с
 * процессором, поэтому выигрыш от неё скромнее, а на ноутбуке с двумя картами
 * человек обычно хочет считать именно на отдельной.
 *
 * Признаки отдельной проверяются первыми: в «Radeon RX 7800 XT» есть слово
 * Radeon, как и во встроенной «Radeon 780M Graphics».
 */
export function gpuKind(name: string): GpuKind {
  // «AMD Radeon(TM) 760M Graphics» → «amd radeon 760m graphics». Значки
  // торговых марок стоят в названиях в произвольных местах и только мешают.
  const text = name
    .toLowerCase()
    .replace(/\((?:tm|r|c)\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  // Признаки отдельной карты проверяются первыми: слово «radeon» есть и в
  // «Radeon RX 7800 XT», и во встроенной «Radeon 780M Graphics».
  const discrete = [/\brx \d{3,4}\b/, /\brtx\b|\bgtx\b|geforce|quadro|tesla/, /\bradeon pro\b/, /\barc [ab]\d{3}\b/];
  if (discrete.some((pattern) => pattern.test(text))) return 'discrete';

  const integrated = [
    /\bradeon \d{3}m\b/, // 780M, 760M, 890M — графика внутри процессора
    /\bradeon graphics\b/,
    /\bvega \d* ?graphics\b/,
    /\buhd graphics\b|\bhd graphics\b|\biris\b/, // Intel
    /\bapple m\d/,
  ];
  if (integrated.some((pattern) => pattern.test(text))) return 'integrated';

  // Незнакомое имя считаем отдельной картой: ошибиться в эту сторону дешевле —
  // человека не отговаривают от ускорения, которое, возможно, ему доступно.
  return 'discrete';
}

/** Сборка годится этому железу. */
export function fits(build: AccelBuild, hardware: Hardware): boolean {
  switch (build.requires) {
    case 'none':
      return true;
    case 'nvidia':
      return hardware.nvidia;
    case 'gpu':
      return hardware.nvidia || hardware.amd || hardware.intel;
  }
}

export interface AccelChoice {
  build: AccelBuild;
  /** Почему выбрана именно эта сборка — уходит в журнал и в интерфейс. */
  reason: string;
  /** Предупреждение, если выбор сомнителен, но выполним. */
  warning?: string;
}

/**
 * Что использовать при настройке `auto`: только официальные сборки.
 *
 * Видеокарта NVIDIA — берём CUDA, она из релизов самого проекта. Во всех
 * остальных случаях процессор с BLAS. Vulkan сам не подставляется, даже если
 * подходящая видеокарта есть: архив собран третьей стороной, и молча подсунуть
 * его вместо официального нельзя.
 */
export function chooseAccel(preference: AccelPreference, hardware: Hardware): AccelChoice {
  if (preference === 'auto') {
    if (hardware.nvidia) {
      return { build: ACCEL_BUILDS.cuda, reason: 'найдена видеокарта NVIDIA' };
    }
    const gpu = hardware.amd || hardware.intel;
    return {
      build: ACCEL_BUILDS.blas,
      reason: gpu
        ? 'официальной сборки под эту видеокарту нет; для неё есть Vulkan — включается вручную'
        : 'подходящей видеокарты не найдено',
    };
  }

  const build = ACCEL_BUILDS[preference];
  const choice: AccelChoice = { build, reason: 'выбрано в настройках' };
  if (!fits(build, hardware)) {
    choice.warning =
      `Сборка «${build.title}» выбрана вручную, но подходящего устройства не видно` +
      (hardware.adapters.length > 0 ? ` (найдено: ${hardware.adapters.join(', ')})` : '') +
      '. Распознавание может не запуститься.';
  }
  if (!build.origin.official) {
    choice.warning =
      `${choice.warning ? choice.warning + ' ' : ''}Архив собран не проектом whisper.cpp, ` +
      `а ${build.origin.name}: официальных сборок под эту видеокарту не выпускают.`;
  }
  return choice;
}

/** Каталог внутри tools: у каждой сборки свой, чтобы их можно было держать рядом. */
export function accelDir(id: AccelId): string {
  return id === 'blas' ? 'whisper' : `whisper-${id}`;
}

const ADAPTER_QUERY = '(Get-CimInstance Win32_VideoController).Name';

/**
 * Названия видеоадаптеров у системы. Ошибка опроса — не беда: считаем, что
 * видеокарты нет, и остаёмся на процессоре.
 */
export async function detectHardware(): Promise<Hardware> {
  if (process.platform !== 'win32') return classifyAdapters([]);
  try {
    const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ADAPTER_QUERY], {
      timeoutMs: 20_000,
      captureStdout: true,
    });
    const adapters = (result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return classifyAdapters(adapters);
  } catch {
    return classifyAdapters([]);
  }
}

/** Отметка о том, какая сборка стоит в каталоге: что качали и кто её собрал. */
export interface InstalledBuild {
  id: AccelId;
  version: string;
  origin: string;
  url: string;
  installedAt: string;
}

export const BUILD_MARKER = '.build.json';

/**
 * Ставит выбранную сборку whisper.cpp в собственный каталог внутри tools.
 * Уже установленная не перекачивается; рядом кладётся отметка о происхождении,
 * чтобы в интерфейсе и в журнале было видно, чей это бинарник.
 */
export async function provisionWhisperBuild(toolsDir: string, build: AccelBuild): Promise<string> {
  const target = path.join(toolsDir, accelDir(build.id));
  const exe = path.join(target, `whisper-cli${process.platform === 'win32' ? '.exe' : ''}`);
  if (existsSync(exe)) return exe;

  if (process.platform !== 'win32') {
    throw new MissingDependencyError('whisper-cli', 'Автозагрузка whisper.cpp поддерживается только для Windows', [
      'Соберите из исходников: https://github.com/ggml-org/whisper.cpp',
    ]);
  }

  const staging = path.join(toolsDir, `.staging-whisper-${build.id}`);
  const archive = path.join(staging, 'whisper.zip');
  log.info(`Загрузка whisper.cpp (${build.title}, ${build.version}, ${build.origin.name})…`);
  await downloadFile(build.url, archive, { label: `whisper.cpp ${build.id}`, minBytes: build.minBytes, timeoutMs: 1_800_000 });
  await unzip(archive, staging);

  // В архиве рядом с исполняемым файлом лежат его библиотеки — переносим папку целиком.
  const cli = (await findUnder(staging, 'whisper-cli.exe')) ?? (await findUnder(staging, 'main.exe'));
  if (!cli) throw new MissingDependencyError('whisper-cli', 'В архиве whisper.cpp не найден исполняемый файл');
  await mkdir(target, { recursive: true });
  const sourceDir = path.dirname(cli);
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await rename(path.join(sourceDir, entry.name), path.join(target, entry.name));
  }
  if (path.basename(cli).toLowerCase() === 'main.exe') {
    await rename(path.join(target, 'main.exe'), exe);
  }

  const installed: InstalledBuild = {
    id: build.id,
    version: build.version,
    origin: build.origin.name,
    url: build.url,
    installedAt: new Date().toISOString(),
  };
  await writeFile(path.join(target, BUILD_MARKER), JSON.stringify(installed, null, 1), 'utf8');
  await rm(staging, { recursive: true, force: true });
  return exe;
}

/** Что стоит в каталоге сборки, если она вообще ставилась этой программой. */
export function readInstalledBuild(toolsDir: string, id: AccelId): InstalledBuild | null {
  const marker = path.join(toolsDir, accelDir(id), BUILD_MARKER);
  if (!existsSync(marker)) return null;
  try {
    return JSON.parse(readFileSync(marker, 'utf8')) as InstalledBuild;
  } catch {
    return null;
  }
}
