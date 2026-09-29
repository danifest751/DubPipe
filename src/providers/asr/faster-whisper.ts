import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DubConfig } from '../../config/schema.js';
import { packageRoot } from '../../config/load.js';
import { StageError } from '../../core/errors.js';
import { languageProfile } from '../../core/languages.js';
import { log } from '../../core/logger.js';
import { warn, type StageWarning, type WordTiming } from '../../core/types.js';
import type { Workspace } from '../../core/workspace.js';
import { isNonSpeech, mergeWordsIntoSentences } from '../../stages/s2-segments.js';
import { missingPythonModules, probePython } from '../../stages/s4-separate.js';
import { run, ProcessError } from '../../util/exec.js';
import { toWhisperAudio } from '../../util/ffmpeg.js';
import { requireTool } from '../../util/tools.js';
import { discard, dropWorkerJob, packForServer, runWorkerJob, serverTitle, workerHealth } from '../remote/server.js';
import type { AsrProvider, AsrResult } from './index.js';
import { dropBracketedGroups, MAX_WORD_SECONDS } from './whispercpp.js';

/**
 * Распознавание через faster-whisper — для видеокарты NVIDIA.
 *
 * Модель та же, что у whisper.cpp, а считает её CTranslate2 в fp16 на CUDA:
 * large-v3-turbo там быстрее, чем small на процессоре. Скрипт один —
 * `python/asr_whisper.py`, — и запускается он либо на сервере (раздел
 * `server`), либо здесь, если видеокарта стоит в этом компьютере.
 *
 * Словарь моделей общий с whisper.cpp: `small`, `large-v3`, `large-v3-turbo`.
 */

export interface FasterWhisperJson {
  words?: Array<{ word?: string; start?: number; end?: number; probability?: number }>;
  device?: string;
  model?: string;
}

/**
 * Слова с таймкодами из ответа faster-whisper — по тем же правилам, что и у
 * whisper.cpp: описания звуков в скобках и служебные токены выбрасываются, а
 * слово, растянутое на музыкальную паузу, обрезается.
 */
export function parseFasterWhisperWords(json: FasterWhisperJson): WordTiming[] {
  const words = (json.words ?? [])
    .map((item) => ({ word: (item.word ?? '').trim(), start: Number(item.start ?? 0), end: Number(item.end ?? 0) }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));
  return dropBracketedGroups(words)
    .filter((item) => item.word.length > 0 && !isNonSpeech(item.word) && item.end >= item.start)
    .map((item) => ({ ...item, end: Math.min(item.end, item.start + MAX_WORD_SECONDS) }));
}

function scriptPath(): string {
  const fromPackage = path.join(packageRoot(), 'python', 'asr_whisper.py');
  if (existsSync(fromPackage)) return fromPackage;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'python', 'asr_whisper.py');
}

function reportProgress(percent: number): void {
  log.progress(`распознавание ${percent}%`, percent, null, { key: 'work.asr', params: { percent } });
}

export class FasterWhisperProvider implements AsrProvider {
  name = 'faster-whisper';

  constructor(
    private readonly workspace: Workspace,
    private readonly config: DubConfig,
    private readonly where: 'server' | 'local',
  ) {}

  /** Звук 16 кГц моно: его же читают VAD, диаризация и замер тона. */
  private async whisperInput(audioPath: string): Promise<string> {
    const input = this.workspace.file('audio16k.wav');
    if (!existsSync(input)) await toWhisperAudio(audioPath, input, this.workspace.toolsDir);
    return input;
  }

  async transcribe(audioPath: string): Promise<AsrResult> {
    const warnings: StageWarning[] = [];
    const input = await this.whisperInput(audioPath);
    const parsed = this.where === 'server' ? await this.onServer(input) : await this.locally(input);
    if (this.where === 'server' && parsed.device === 'cpu') {
      warnings.push(
        warn('warn.server.cpu', 'Сервер распознал запись на процессоре, а не на видеокарте: не хватило видеопамяти', {
          stage: 'S2',
        }),
      );
    }
    const words = parseFasterWhisperWords(parsed);
    const segments = mergeWordsIntoSentences(words, { wordJoiner: languageProfile(this.config.asr.language).wordJoiner });
    return { segments, words, provider: this.name, warnings };
  }

  private async onServer(input: string): Promise<FasterWhisperJson> {
    const health = await workerHealth(this.config);
    this.name = `faster-whisper ${this.config.asr.model} (${serverTitle(this.config, health)})`;
    // На сервер уходит FLAC: вдвое меньше WAV, а по сети это и есть время.
    const ffmpeg = await requireTool('ffmpeg', this.workspace.toolsDir);
    const upload = await packForServer(ffmpeg, input, this.workspace.file('asr-upload.flac'));

    log.step(`Распознавание на сервере: модель ${this.config.asr.model}`);
    let lastStep = -10;
    try {
      const job = await runWorkerJob(
        this.config,
        'asr',
        { model: this.config.asr.model, language: this.config.asr.language },
        upload,
        {
          onProgress: (percent) => {
            reportProgress(percent);
            if (percent - lastStep >= 10 || percent === 100) {
              lastStep = percent;
              log.step(`распознано ${percent}%`);
            }
          },
          onLog: (text) => log.debug(`сервер: ${text}`),
        },
      );
      await dropWorkerJob(this.config, job.job);
      log.step(`распознавание на сервере заняло ${Math.round(job.seconds)} с`);
      return (job.result ?? {}) as FasterWhisperJson;
    } finally {
      await discard(upload);
    }
  }

  private async locally(input: string): Promise<FasterWhisperJson> {
    const python = await probePython();
    const missing = python.executable ? await missingPythonModules(python.executable, ['faster_whisper']) : ['python'];
    if (!python.executable || missing.length > 0) {
      throw new StageError('s2', `для faster-whisper не хватает: ${missing.join(', ')}`, {
        hints: ['pip install faster-whisper', 'Либо вернитесь на whisper.cpp: asr.engine: whisper-cpp'],
      });
    }
    this.name = `faster-whisper ${this.config.asr.model} (локально)`;
    const output = this.workspace.file('asr-faster-whisper.json');
    log.step(`Распознавание: faster-whisper, модель ${this.config.asr.model}`);
    try {
      await run(
        python.executable,
        [
          '-X', 'utf8', scriptPath(),
          '--input', input,
          '--output', output,
          '--model', this.config.asr.model,
          '--language', this.config.asr.language,
          '--cache-dir', path.join(this.workspace.modelsDir, 'hf'),
        ],
        {
          timeoutMs: 6 * 3_600_000,
          onStderr: (chunk) => {
            const match = /progress=(\d+)/.exec(chunk);
            if (match) reportProgress(Number(match[1]));
            else if (chunk.trim()) log.debug(chunk.trim());
          },
        },
      );
    } catch (error) {
      const detail = error instanceof ProcessError ? error.stderr.trim().split('\n').slice(-2).join('; ') : (error as Error).message;
      throw new StageError('s2', `faster-whisper не распознал запись: ${detail}`, { cause: error });
    }
    return JSON.parse(await readFile(output, 'utf8')) as FasterWhisperJson;
  }
}
