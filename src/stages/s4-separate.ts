import path from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { DubConfig } from '../config/schema.js';
import { packageRoot } from '../config/load.js';
import { StageError } from '../core/errors.js';
import { log } from '../core/logger.js';
import type { Workspace } from '../core/workspace.js';
import { run, ProcessError } from '../util/exec.js';
import { downloadFile } from '../util/download.js';
import { requireTool } from '../util/tools.js';

/**
 * S4 — separating voice from music and effects (SPEC FR-4).
 *
 * Runs an MDX-Net ONNX model through a Python sidecar. The spec allows Python
 * for exactly this stage (§0.3), and it is the right call: the model needs a
 * 6144-point FFT per frame, which numpy does in native code orders of magnitude
 * faster than a hand-rolled JavaScript implementation would. PyTorch is not
 * involved — only numpy and onnxruntime.
 *
 * The stage is optional and degrades to ducking when the environment lacks the
 * pieces, instead of failing the run (SPEC FR-4, revised).
 */

const MODEL_SOURCES: Record<string, string> = {
  'UVR-MDX-NET-Inst_HQ_3': 'https://huggingface.co/seanghay/uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx',
  'UVR-MDX-NET-Inst_HQ_4': 'https://huggingface.co/seanghay/uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_4.onnx',
  'UVR_MDXNET_Main': 'https://huggingface.co/seanghay/uvr_models/resolve/main/UVR_MDXNET_Main.onnx',
};

/** MDX-Net expects 44.1 kHz stereo. */
const MODEL_SAMPLE_RATE = 44_100;

export interface PythonEnvironment {
  available: boolean;
  executable: string | null;
  missing: string[];
  /** Исполнители onnxruntime: по ним видно, доступна ли видеокарта стадиям на Python. */
  providers: string[];
}

/**
 * Одна проба на всё: какие модули есть и каких исполнителей видит onnxruntime.
 * Список исполнителей показывает, доступна ли видеокарта стадиям на Python —
 * `doctor` печатает это, чтобы человек не гадал, где что считается.
 */
const PROBE_SCRIPT = [
  'import json',
  'missing = []',
  'try:',
  ' import numpy',
  'except ImportError:',
  ' missing.append("numpy")',
  'providers = []',
  'try:',
  ' import onnxruntime',
  ' providers = list(onnxruntime.get_available_providers())',
  'except ImportError:',
  ' missing.append("onnxruntime")',
  'print(json.dumps({"missing": missing, "providers": providers}))',
].join(String.fromCharCode(10));

/** Checks for Python and the two modules the sidecar needs. */
export async function probePython(): Promise<PythonEnvironment> {
  const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];

  for (const executable of candidates) {
    try {
      const { stdout } = await run(
        executable,
        ['-c', PROBE_SCRIPT],
        { timeoutMs: 60_000 },
      );
      const probe = JSON.parse(stdout.trim() || '{}') as { missing?: string[]; providers?: string[] };
      const missing = probe.missing ?? [];
      return { available: missing.length === 0, executable, missing, providers: probe.providers ?? [] };
    } catch {
      continue;
    }
  }
  return { available: false, executable: null, missing: ['python'], providers: [] };
}

export interface S4Result {
  backgroundPath: string | null;
  warnings: string[];
  provider: string;
  /** True when the stage stepped aside and S7 must duck instead. */
  degradedToDucking: boolean;
}

function sidecarPath(): string {
  const fromPackage = path.join(packageRoot(), 'python', 'mdx_separate.py');
  if (existsSync(fromPackage)) return fromPackage;
  // Running from dist/: the script lives next to the package root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'python', 'mdx_separate.py');
}

export async function runS4(workspace: Workspace, config: DubConfig): Promise<S4Result> {
  const warnings: string[] = [];

  const python = await probePython();
  if (!python.available) {
    const reason =
      python.executable === null
        ? 'Python не найден в системе'
        : `не установлены модули: ${python.missing.join(', ')}`;
    const hints = [
      python.executable === null
        ? 'Установите Python 3.10+ и повторите'
        : `${python.executable} -m pip install ${python.missing.join(' ')}`,
      'Либо отключите стадию: separation.enabled: false',
    ];

    if (config.separation.fallback_to_ducking) {
      warnings.push(
        `Отделение голоса пропущено (${reason}). Оригинал будет приглушён на ${config.mix.duck_db} дБ ` +
          'в речевых окнах (ТЗ FR-4). ' + hints[0],
      );
      return { backgroundPath: null, warnings, provider: 'пропущено', degradedToDucking: true };
    }
    throw new StageError('s4', `разделение недоступно: ${reason}`, { hints });
  }

  const script = sidecarPath();
  if (!existsSync(script)) {
    throw new StageError('s4', 'не найден скрипт разделения', { artifact: script });
  }

  const source = MODEL_SOURCES[config.separation.model];
  if (!source) {
    throw new StageError('s4', `неизвестная модель разделения «${config.separation.model}»`, {
      hints: [`Доступны: ${Object.keys(MODEL_SOURCES).join(', ')}`],
    });
  }

  const modelPath = path.join(workspace.modelsDir, `${config.separation.model}.onnx`);
  if (!existsSync(modelPath)) {
    await downloadFile(source, modelPath, {
      label: `модель разделения ${config.separation.model}`,
      minBytes: 10_000_000,
      timeoutMs: 1_800_000,
    });
  }

  const ffmpeg = await requireTool('ffmpeg', workspace.toolsDir);
  const original = workspace.file('original.wav');
  if (!existsSync(original)) {
    throw new StageError('s4', 'нет исходного аудио для разделения', {
      artifact: original,
      hints: ['Выполните стадию s1'],
    });
  }

  // The model works at its own rate and layout; convert in and back out.
  const modelInput = workspace.file('separate-input.wav');
  await run(
    ffmpeg,
    ['-y', '-v', 'error', '-i', original, '-ar', String(MODEL_SAMPLE_RATE), '-ac', '2', '-acodec', 'pcm_s16le', modelInput],
    { timeoutMs: 1_800_000 },
  );

  const instrumental = workspace.file('separate-instrumental.wav');
  const separatedVocals = workspace.file('separate-vocals.wav');

  log.step(`разделение моделью ${config.separation.model} (Python + onnxruntime)`);
  try {
    await run(
      python.executable!,
      [
        script,
        '--model',
        modelPath,
        '--input',
        modelInput,
        '--output-instrumental',
        instrumental,
        '--output-vocals',
        separatedVocals,
        '--device',
        config.separation.device,
      ],
      {
        timeoutMs: 6 * 3_600_000,
        captureStdout: true,
        onStderr: (chunk) => {
          const match = /progress=(\d+)/.exec(chunk);
          if (match) {
            log.step(`разделено ${match[1]}%`);
            log.progress(`разделение ${match[1]}%`, Number(match[1]), null, { key: 'work.separate', params: { percent: Number(match[1]) } });
          }
          else if (chunk.trim()) log.debug(chunk.trim());
        },
      },
    );
  } catch (error) {
    const detail = error instanceof ProcessError ? error.stderr.trim().split('\n').slice(-3).join('; ') : '';
    if (config.separation.fallback_to_ducking) {
      warnings.push(
        `Разделение не удалось (${detail || (error as Error).message}); ` +
          `оригинал будет приглушён на ${config.mix.duck_db} дБ в речевых окнах`,
      );
      return { backgroundPath: null, warnings, provider: 'ошибка, откат на дакинг', degradedToDucking: true };
    }
    throw new StageError('s4', `разделение не удалось: ${detail || (error as Error).message}`, { cause: error });
  }

  const background = workspace.file('background.wav');
  await run(
    ffmpeg,
    ['-y', '-v', 'error', '-i', instrumental, '-ar', '48000', '-acodec', 'pcm_s16le', background],
    { timeoutMs: 1_800_000 },
  );
  // Голос приводится к той же частоте, что и оригинал: сведение вычитает его
  // из оригинала, а вычитать дорожки разной частоты нельзя.
  const vocals = workspace.file('vocals.wav');
  await run(
    ffmpeg,
    ['-y', '-v', 'error', '-i', separatedVocals, '-ar', '48000', '-acodec', 'pcm_s16le', vocals],
    { timeoutMs: 1_800_000 },
  );
  await rm(modelInput, { force: true });
  await rm(separatedVocals, { force: true });
  await rm(instrumental, { force: true });

  return {
    backgroundPath: background,
    warnings,
    provider: `MDX-Net ${config.separation.model}`,
    degradedToDucking: false,
  };
}
