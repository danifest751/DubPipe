import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import type { DubConfig } from '../../config/schema.js';
import { StageError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import type { WordTiming, StageWarning } from '../../core/types.js';
import type { Workspace } from '../../core/workspace.js';
import { run } from '../../util/exec.js';
import { downloadFile } from '../../util/download.js';
import { provisionTool } from '../../util/tools.js';
import {
  ACCEL_BUILDS,
  chooseAccel,
  classifyAdapters,
  detectHardware,
  provisionWhisperBuild,
  type AccelId,
} from './accel.js';
import { toWhisperAudio } from '../../util/ffmpeg.js';
import { isNonSpeech, mergeWordsIntoSentences } from '../../stages/s2-segments.js';
import { languageProfile } from '../../core/languages.js';
import type { AsrProvider, AsrResult } from './index.js';

/**
 * Local ASR through the whisper.cpp CLI (SPEC §15.1, profiles A and B).
 * Runs word by word so timestamps land on the original timeline — the gateway
 * returns no timestamps at all (SPEC §3.1.1).
 */

const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const VAD_BASE = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main';

/** Approximate download sizes, used only to catch truncated downloads. */
const MODEL_MIN_BYTES: Record<string, number> = {
  tiny: 60_000_000,
  base: 100_000_000,
  small: 400_000_000,
  medium: 1_300_000_000,
  'large-v3': 2_800_000_000,
};

function modelMinBytes(model: string): number {
  const base = model.split('-q')[0] ?? model;
  const full = MODEL_MIN_BYTES[base] ?? 50_000_000;
  return model.includes('-q') ? Math.round(full / 4) : full;
}

/** Путь к весам whisper для модели из конфига; загружает их при отсутствии. */
export async function ensureWhisperModel(model: string, modelsDir: string): Promise<string> {
  const fileName = `ggml-${model}.bin`;
  const target = path.join(modelsDir, fileName);
  if (existsSync(target)) return target;
  await downloadFile(`${MODEL_BASE}/${fileName}`, target, {
    label: `модель распознавания «${model}»`,
    minBytes: modelMinBytes(model),
    timeoutMs: 3_600_000,
  });
  return target;
}

/** Модель VAD в формате whisper.cpp; загружает её при отсутствии. */
export async function ensureWhisperVadModel(name: string, modelsDir: string): Promise<string> {
  const fileName = `${name}.bin`;
  const target = path.join(modelsDir, fileName);
  if (existsSync(target)) return target;
  await downloadFile(`${VAD_BASE}/${fileName}`, target, {
    label: 'модель VAD для whisper',
    minBytes: 500_000,
    timeoutMs: 600_000,
  });
  return target;
}

export function whisperModelPath(model: string, modelsDir: string): string {
  return path.join(modelsDir, `ggml-${model}.bin`);
}

interface WhisperToken {
  text?: string;
  /** DTW-таймкод токена в сотых долях секунды; -1 — не вычислен. */
  t_dtw?: number;
}

interface WhisperTranscriptionItem {
  tokens?: WhisperToken[];
  offsets?: { from?: number; to?: number };
  text?: string;
}

export interface WhisperJson {
  transcription?: WhisperTranscriptionItem[];
}

/**
 * In --max-len 1 mode every transcription item is a single word whose offsets
 * are expressed on the original timeline — unlike token offsets, which shift
 * when VAD is on. These are the word timings the rest of S2 relies on.
 */
/**
 * Дольше этого ни одно слово не звучит. Whisper растягивает последнее слово
 * фразы до начала следующей — через музыкальную паузу это десятки секунд;
 * начало у такого слова верное, конец обрезается.
 */
export const MAX_WORD_SECONDS = 2.5;

/** Начало слова по DTW: самый ранний вычисленный таймкод его токенов. */
function dtwStart(item: WhisperTranscriptionItem): number | null {
  const stamps = (item.tokens ?? []).map((token) => token.t_dtw ?? -1).filter((stamp) => stamp >= 0);
  return stamps.length > 0 ? Math.min(...stamps) / 100 : null;
}

/** Если DTW не дал ни одного слова, конец слова ставится через столько после начала. */
const FALLBACK_WORD_SECONDS = 0.3;

/**
 * Слова с таймкодами. Эвристические offsets whisper ставят первые слова фразы
 * на её начало по сегменту — на реальной записи это 0.4–1.2 с раньше речи,
 * и русская реплика стартует до того, как персонаж откроет рот. Поэтому начало
 * слова берётся из DTW-таймкодов токенов (когда они есть), а конец — не позже
 * начала следующего слова и эвристического конца.
 */
/** Сколько слов подряд может занимать описание звука: дальше скобка считается случайной. */
export const MAX_BRACKETED_WORDS = 8;

/**
 * Выбрасывает описания звуков в скобках: «(eerie music)», «[door creaks]».
 * Пословный режим whisper разрезает их на отдельные токены, и проверка слова
 * целиком такое не ловит — в субтитрах оригинала оставалось «(eerie».
 * Незакрытая скобка ничего не съедает: без пары группа не считается описанием.
 */
export function dropBracketedGroups<T extends { word: string }>(words: T[]): T[] {
  const result: T[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!.word;
    const opening = /^[([{]/.test(word);
    if (!opening) {
      result.push(words[i]!);
      continue;
    }
    // Ищем закрывающую скобку неподалёку; нашли — пропускаем всю группу.
    const limit = Math.min(words.length, i + MAX_BRACKETED_WORDS);
    let close = -1;
    for (let j = i; j < limit; j++) {
      if (/[)\]}][^\p{L}\p{N}]*$/u.test(words[j]!.word)) {
        close = j;
        break;
      }
    }
    if (close < 0) {
      result.push(words[i]!);
      continue;
    }
    i = close;
  }
  return result;
}

export function parseWhisperWords(json: WhisperJson): WordTiming[] {
  // Порядок важен: скобочные группы снимаются до отсева одиночных служебных
  // токенов. Иначе «music)» уходит первым, и от «(eerie music)» остаётся «(eerie».
  const raw = dropBracketedGroups(
    (json.transcription ?? []).map((item) => ({
      word: (item.text ?? '').trim(),
      start: (item.offsets?.from ?? 0) / 1000,
      end: (item.offsets?.to ?? 0) / 1000,
      dtw: dtwStart(item),
    })),
  )
    // Музыка, шум и маркеры смены говорящего (>>) речью не являются.
    .filter((word) => word.word.length > 0 && !isNonSpeech(word.word) && word.end >= word.start);

  return raw.map((word, index) => {
    if (word.dtw === null) {
      const end = word.end - word.start > MAX_WORD_SECONDS ? word.start + MAX_WORD_SECONDS : word.end;
      return { word: word.word, start: word.start, end };
    }
    const start = word.dtw;
    const next = raw[index + 1]?.dtw ?? null;
    const bounds = [word.end, next].filter((value): value is number => value !== null && value > start);
    const end = bounds.length > 0 ? Math.min(...bounds) : start + FALLBACK_WORD_SECONDS;
    return { word: word.word, start, end: Math.min(end, start + MAX_WORD_SECONDS) };
  });
}

/** Имя набора голов внимания whisper.cpp для DTW по имени модели: `large-v3` → `large.v3`. */
export function dtwPreset(model: string): string {
  return model.replace(/^ggml-/, '').replace(/-v(\d)/, '.v$1').replace(/-turbo$/, '.turbo');
}

export class WhisperCppProvider implements AsrProvider {
  /** Уточняется после выбора сборки: в отчёте видно, на чём считалось. */
  name = 'whisper.cpp (локально, CPU)';

  constructor(
    private readonly workspace: Workspace,
    private readonly config: DubConfig,
  ) {}

  private ensureModel(): Promise<string> {
    return ensureWhisperModel(this.config.asr.model, this.workspace.modelsDir);
  }

  /**
   * Исполняемый файл whisper.cpp под выбранный ускоритель.
   *
   * Обычная сборка ищется и в PATH: у человека может стоять своя. Сборки под
   * видеокарту лежат каждая в своём каталоге, поэтому переключение настройки
   * не требует ничего удалять — рядом просто появляется вторая.
   */
  private async resolveBinary(): Promise<string> {
    const preference = this.config.asr.backend;
    // Опрос видеоадаптеров нужен только там, где от него зависит выбор.
    const hardware =
      preference === 'auto' || ACCEL_BUILDS[preference as AccelId]?.requires !== 'none'
        ? await detectHardware()
        : classifyAdapters([]);
    const choice = chooseAccel(preference, hardware);
    if (choice.warning) log.warn(choice.warning);

    this.name = `whisper.cpp (локально, ${choice.build.title})`;
    if (choice.build.id === 'blas') {
      const tool = await provisionTool('whisper-cli', this.workspace.toolsDir);
      log.step(`whisper.cpp: ${choice.build.title} (${choice.reason})`);
      return tool.path;
    }
    const binary = await provisionWhisperBuild(this.workspace.toolsDir, choice.build);
    log.step(`whisper.cpp: ${choice.build.title} (${choice.reason})`);
    return binary;
  }

  async transcribe(audioPath: string): Promise<AsrResult> {
    const warnings: StageWarning[] = [];
    const binary = await this.resolveBinary();
    const model = await this.ensureModel();

    // whisper.cpp only reads 16 kHz mono PCM.
    const whisperInput = this.workspace.file('audio16k.wav');
    if (!existsSync(whisperInput)) {
      await toWhisperAudio(audioPath, whisperInput, this.workspace.toolsDir);
    }

    const outputPrefix = this.workspace.file('asr');
    const threads = this.config.asr.threads ?? Math.max(1, Math.min(cpus().length, 16));

    const args = [
      '-m', model,
      '-f', whisperInput,
      '-l', this.config.asr.language,
      '-t', String(threads),
      '--output-json-full',
      '-of', outputPrefix,
      // Пословный вывод: единственный режим с честными word-таймкодами.
      '--max-len', '1',
      '--split-on-word',
      '-pp',
      /*
       * Не подавать модели её же предыдущий текст как подсказку. С подсказкой
       * одна выдумка тянет следующую: на корейском эпизоде формула из титров
       * («предоставлены субтитры, содержит рекламу») заняла 68 реплик подряд и
       * вытеснила три с половиной минуты диалога — речь в этом окне не была
       * записана вовсе. На тех же пяти минутах без подсказки формулы вдвое
       * меньше по времени (44 с против 79), а связность страдает мало.
       */
      '-mc', '0',
    ];

    if (this.config.asr.timestamps === 'dtw') {
      // Таймкоды токенов по выравниванию внимания (DTW): эвристика по вероятностям
      // ставит первые слова фразы раньше речи. DTW несовместим с flash attention.
      args.push('-dtw', dtwPreset(this.config.asr.model), '-nfa');
    }

    /*
     * Встроенный VAD whisper.cpp намеренно НЕ включается. Он режет аудио на
     * речевые куски и отображает таймкоды обратно, и на реальной записи это
     * отображение ломается: слово перед двухминутной музыкальной паузой
     * получало длительность 140 секунд, четыре слова внутри фразы сжимались
     * в 0.1 с, а половина речи терялась вовсе (152 слова против 418 без VAD).
     * Музыку и шум whisper без VAD помечает токенами [MUSIC]/[NOISE], которые
     * отбрасываются при разборе, а границы реплик уточняет отдельный silero VAD.
     */

    log.step(`Распознавание: модель ${this.config.asr.model}, потоков ${threads}`);
    const started = Date.now();
    await run(binary, args, {
      timeoutMs: 6 * 3_600_000,
      captureStdout: false,
      onStderr: (chunk) => {
        const match = /progress\s*=\s*(\d+)%/.exec(chunk);
        if (match) {
          log.step(`распознано ${match[1]}%`);
          log.progress(`распознавание ${match[1]}%`, Number(match[1]), null, { key: 'work.asr', params: { percent: Number(match[1]) } });
        }
        else log.debug(chunk.trim());
      },
    });
    log.debug(`whisper.cpp завершён за ${Math.round((Date.now() - started) / 1000)} с`);

    const jsonPath = `${outputPrefix}.json`;
    if (!existsSync(jsonPath)) {
      throw new StageError('s2', 'whisper.cpp не создал JSON с результатом', { artifact: jsonPath });
    }

    let parsed: WhisperJson;
    try {
      parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as WhisperJson;
    } catch (cause) {
      throw new StageError('s2', `Не удалось разобрать вывод whisper.cpp: ${(cause as Error).message}`, {
        artifact: jsonPath,
        cause,
      });
    }

    const words = parseWhisperWords(parsed);
    const segments = mergeWordsIntoSentences(words, { wordJoiner: languageProfile(this.config.asr.language).wordJoiner });
    return { segments, words, provider: this.name, warnings };
  }
}
