import { makeSegment, type Segment, type SegmentFlag, type WordTiming } from '../core/types.js';
import { KNOWN_HALLUCINATIONS } from './hallucination-phrases.js';

/**
 * Segment post-processing (SPEC FR-2). Pure functions only: no ffmpeg, no
 * network, no model — so the timing rules are unit-testable on their own
 * (SPEC §9, revised).
 */

export const MIN_SEGMENT_SECONDS = 0.4;
export const MAX_SEGMENT_SECONDS = 30;
/** Pause thresholds tried in order when splitting an over-long replica. */
export const PAUSE_THRESHOLDS_MS = [400, 300, 200, 150] as const;

export interface RawSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words?: WordTiming[];
  flags?: SegmentFlag[];
}

/** Whisper marks music and noise with bracketed tags; those are not speech. */
const NON_SPEECH = /^[\s]*[[(<*]?\s*(music|sounds?|noise|applause|laughter|silence|blank[_ ]audio|inaudible|foreign|no speech)[^\])>*]*[\])>*]?[\s.!?]*$/i;

export function isNonSpeech(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (NON_SPEECH.test(trimmed)) return true;
  // Text made up solely of punctuation or musical notes carries no speech.
  return !/[\p{L}\p{N}]/u.test(trimmed);
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Snaps segment edges onto the first and last word timestamps, but only when the
 * correction stays inside the allowed window — this is what brings whisper's
 * loose segment edges inside the ±250 ms tolerance (SPEC FR-2).
 */
export function refineBoundaries(segment: RawSegment, windowMs: number): RawSegment {
  const words = segment.words?.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)) ?? [];
  if (words.length === 0) return segment;

  const window = windowMs / 1000;
  const first = words[0]!;
  const last = words[words.length - 1]!;

  let start = segment.start;
  let end = segment.end;

  if (first.start >= segment.start - window && first.start <= segment.start + window) start = first.start;
  if (last.end >= segment.end - window && last.end <= segment.end + window) end = last.end;
  if (end <= start) return segment;

  return { ...segment, start, end };
}

interface SplitPoint {
  index: number;
  gapMs: number;
}

/** Gaps between consecutive words, largest first among those above the threshold. */
function pauseCandidates(words: WordTiming[], thresholdMs: number): SplitPoint[] {
  const points: SplitPoint[] = [];
  for (let i = 1; i < words.length; i++) {
    const gapMs = (words[i]!.start - words[i - 1]!.end) * 1000;
    if (gapMs > thresholdMs) points.push({ index: i, gapMs });
  }
  return points;
}

function sliceByWords(segment: RawSegment, from: number, to: number, flags: SegmentFlag[] = []): RawSegment {
  const words = segment.words!.slice(from, to);
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: normalizeText(words.map((w) => w.word).join(' ')),
    ...(segment.speaker !== undefined ? { speaker: segment.speaker } : {}),
    words,
    flags: [...(segment.flags ?? []), ...flags],
  };
}

/** Splits proportionally when word timings are unavailable. */
function splitWithoutWords(segment: RawSegment): RawSegment[] {
  const tokens = segment.text.split(/\s+/).filter(Boolean);
  const mid = Math.max(1, Math.floor(tokens.length / 2));
  const midTime = (segment.start + segment.end) / 2;
  if (tokens.length < 2) return [segment];
  return [
    {
      ...segment,
      end: midTime,
      text: normalizeText(tokens.slice(0, mid).join(' ')),
      flags: [...(segment.flags ?? []), 'force_split'],
    },
    {
      ...segment,
      start: midTime,
      text: normalizeText(tokens.slice(mid).join(' ')),
      flags: [...(segment.flags ?? []), 'force_split'],
    },
  ];
}

/**
 * Splits a replica longer than maxSeconds. Pause thresholds are tried from
 * widest to narrowest; if none yields a cut, the replica is cut at the word
 * boundary closest to its midpoint (SPEC FR-2, revised).
 */
export function splitLongSegment(segment: RawSegment, maxSeconds = MAX_SEGMENT_SECONDS): RawSegment[] {
  if (segment.end - segment.start <= maxSeconds) return [segment];

  const words = segment.words ?? [];
  if (words.length < 2) {
    // Без word-таймкодов режем текст пополам, пока есть что резать. Одно слово,
    // растянутое ASR на минуту (обычно музыка или тишина), неделимо — оно
    // возвращается как есть. Без этой проверки функция вызывала себя бесконечно
    // и валила распознавание с «Maximum call stack size exceeded».
    const parts = splitWithoutWords(segment);
    if (parts.length < 2) return [segment];
    return parts.flatMap((part) => splitLongSegment(part, maxSeconds));
  }

  for (const threshold of PAUSE_THRESHOLDS_MS) {
    const candidates = pauseCandidates(words, threshold);
    if (candidates.length === 0) continue;
    // Cut at the pause nearest the middle to keep the halves balanced.
    const middle = words.length / 2;
    const best = candidates.reduce((a, b) => (Math.abs(a.index - middle) <= Math.abs(b.index - middle) ? a : b));
    return [
      ...splitLongSegment(sliceByWords(segment, 0, best.index), maxSeconds),
      ...splitLongSegment(sliceByWords(segment, best.index, words.length), maxSeconds),
    ];
  }

  const cut = Math.max(1, Math.round(words.length / 2));
  return [
    ...splitLongSegment(sliceByWords(segment, 0, cut, ['force_split']), maxSeconds),
    ...splitLongSegment(sliceByWords(segment, cut, words.length, ['force_split']), maxSeconds),
  ];
}

/** Sentence-final punctuation, used to regroup word-level ASR output. */
const SENTENCE_END = /[.!?…]["')\]]?$/;

export interface MergeOptions {
  /** Чем склеивать слова: в письменностях без пробелов — пустой строкой. */
  wordJoiner?: string;
  /** A pause longer than this always starts a new replica. */
  maxGapMs?: number;
  /** Hard ceiling so a run-on passage still gets cut. */
  maxSeconds?: number;
}

/**
 * Rebuilds replicas from word-level ASR output.
 *
 * whisper.cpp reports trustworthy timestamps per word only in --max-len 1 mode,
 * so recognition runs word by word and sentences are reassembled here: a replica
 * ends at sentence punctuation, at a long pause, or at the duration ceiling.
 */
export function mergeWordsIntoSentences(words: WordTiming[], options: MergeOptions = {}): RawSegment[] {
  // В китайском и японском между словами нет пробелов: склейка через пробел
  // даёт «你 好 吗» — и в субтитрах, и в запросе на перевод.
  const { maxGapMs = 700, maxSeconds = 15, wordJoiner = ' ' } = options;
  const segments: RawSegment[] = [];
  let current: WordTiming[] = [];

  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      text: normalizeText(current.map((w) => w.word).join(wordJoiner)),
      words: current,
    });
    current = [];
  };

  for (const [index, word] of words.entries()) {
    current.push(word);
    const next = words[index + 1];
    if (!next) break;

    const gapMs = (next.start - word.end) * 1000;
    const durationExceeded = next.end - current[0]!.start > maxSeconds;
    if (SENTENCE_END.test(word.word) || gapMs > maxGapMs || durationExceeded) flush();
  }
  flush();

  return segments;
}

/** Flags every segment that shares time with its neighbour (SPEC §8). */
export function markOverlaps(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (current.start < previous.end - 1e-6) {
      previous.overlap = true;
      current.overlap = true;
    }
  }
  return sorted;
}

export interface BuildOptions {
  /** ±window for snapping edges to word timings; 0 disables refinement. */
  vadWindowMs?: number;
  minSeconds?: number;
  maxSeconds?: number;
}

/**
 * Фразы, которых в фильме не было: whisper выучил их из субтитров обучающей
 * выборки и вставляет на музыке и в тишине. На корейской дораме такая формула
 * про субтитры и рекламу заняла 68 реплик из 412 — каждая шестая.
 *
 * Список намеренно узкий: сюда попадают только служебные формулы озвучки и
 * титров, а не обычные слова, которые могут прозвучать в кадре.
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
  // Корейский: «предоставлены субтитры», «субтитры by такой-то», «субтитры
  // выбираются в настройках», «содержит рекламу», «подпишитесь». Вариантов у
  // формулы много, и список приходится расширять под каждый новый — это его
  // слабое место, поэтому главный заслон стоит раньше, на декодировании.
  /자막[은는이가]?\s*(제공|출처|by|설정)/iu,
  /한글\s*자막/u,
  /광고를?\s*포함/u,
  /구독\s*(과|와|,)?\s*좋아요/u,
  /시청해\s*주셔서\s*감사/u,
  // Английский: типовые концовки роликов и кредиты субтитров.
  /\bsubtitles?\s+(by|provided\s+by)\b/i,
  /\bthanks?\s+for\s+watching\b/i,
  /\bplease\s+subscribe\b/i,
  // Русский: те же формулы в переводных субтитрах.
  /субтитры\s+(сделал|подготовил|предоставл)/iu,
  /спасибо\s+за\s+просмотр/iu,
  // Подпись переводчика целой репликой: «by 한효정». Только с именем не на
  // латинице — иначе под правило попадает обычное «by the way».
  /^by\s+[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}]/u,
  // Ссылки: в речи их не бывает, а в титрах сколько угодно.
  /\b(?:https?:\/\/|www\.)\S+/i,
];

/**
 * Обрывки той же формулы: модель начинает её и обрывается на первом слове.
 * На корейском эпизоде так осталось три реплики из одного слова «한글», и
 * переводчик сделал из них «Корейский» и «Субтитры» — в дубляже это слышно.
 *
 * Здесь именно точное совпадение со всей репликой: то же слово внутри живой
 * фразы ничего не значит и остаётся.
 */
const HALLUCINATION_FRAGMENTS = new Set([
  '한글',
  '자막',
  '광고',
  '포함하고 있습니다', // хвост той же фразы: «…и содержит рекламу»
  'subtitles',
  'subtitle',
  'субтитры',
]);

/** Текст — служебная формула из титров, а не речь из фильма. */
export function isHallucination(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  // Хвостовые знаки препинания и корейские падежные частицы: «자막은» — то же
  // «자막», просто в именительном падеже.
  const bare = clean
    .replace(/[\p{P}\s]+$/u, '')
    .replace(/(?<=[\p{Script=Hangul}])(은|는|이|가|을|를|도|만)$/u, '')
    .toLowerCase();
  if (HALLUCINATION_FRAGMENTS.has(bare)) return true;
  // Собранные на шуме формулы сравниваются с репликой целиком и в том же виде,
  // в каком собраны: без знаков препинания, строчными, одиночными пробелами.
  const normalized = clean
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (KNOWN_HALLUCINATIONS.has(normalized)) return true;
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(clean));
}

/** Сколько раз подряд повторяется одна и та же группа слов в начале текста. */
function loopLength(words: string[], size: number): number {
  const chunk = words.slice(0, size).join(' ');
  let times = 0;
  while (words.slice(times * size, (times + 1) * size).join(' ') === chunk) times++;
  return times;
}

/**
 * Whisper иногда зацикливается внутри одной реплики и повторяет фразу подряд
 * несколько раз. Оставляем одно вхождение: остальное — артефакт декодирования.
 */
export function trimLoopedText(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length < 6) return text.trim();
  for (let size = 1; size <= Math.floor(words.length / 3); size++) {
    const times = loopLength(words, size);
    if (times >= 3 && times * size === words.length) {
      return words.slice(0, size).join(' ');
    }
  }
  return text.trim();
}

/** Одинаковый текст без учёта регистра и лишних пробелов. */
function sameText(a: string, b: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * Схлопывает залипания: подряд идущие реплики с одинаковым текстом, которые
 * накладываются друг на друга по времени.
 *
 * Признак именно наложение, а не длина серии. Замер на корейской дораме:
 * формула-галлюцинация повторилась 68 раз, максимум 42 подряд, и дала 16
 * наложений; реплика робота — 24 раза, 5 наложений. А настоящая речь —
 * «серьёзно?» 15 раз, «угу» 13 раз, имя героя 14 раз, серии до 12 подряд —
 * не дала ни одного наложения. Человек не может произнести фразу, не закончив
 * предыдущую; декодер whisper может.
 */
export function collapseRepeats<T extends { start: number; end: number; text: string }>(segments: T[]): T[] {
  const result: T[] = [];
  let index = 0;
  while (index < segments.length) {
    const current = segments[index]!;
    let last = index;
    while (last + 1 < segments.length && sameText(segments[last + 1]!.text, current.text)) last++;

    const run = last - index + 1;
    const overlapping = segments
      .slice(index, last + 1)
      .some((segment, position, group) => position > 0 && segment.start < group[position - 1]!.end - 0.01);

    result.push(current);
    // Наложение внутри серии — залипание: берём только первую реплику.
    index = run > 1 && overlapping ? last + 1 : index + 1;
  }
  return result;
}

/**
 * Full S2 post-processing: refine edges → drop noise and sub-0.4 s fragments →
 * split over-long replicas → renumber → flag overlaps.
 */
export function buildSegments(raw: RawSegment[], options: BuildOptions = {}): Segment[] {
  const { vadWindowMs = 400, minSeconds = MIN_SEGMENT_SECONDS, maxSeconds = MAX_SEGMENT_SECONDS } = options;

  const refined = raw
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .map((segment) => (vadWindowMs > 0 ? refineBoundaries(segment, vadWindowMs) : segment));

  const split = refined.flatMap((segment) => splitLongSegment(segment, maxSeconds));

  // Галлюцинации whisper: служебные формулы из титров и залипания на одном
  // тексте. Их отсеиваем до нарезки на реплики, иначе они уходят в перевод,
  // озвучиваются и занимают эфир вместо настоящей речи.
  const cleaned = collapseRepeats(split.map((segment) => ({ ...segment, text: trimLoopedText(segment.text) })));

  const kept = cleaned.filter(
    (segment) =>
      !isNonSpeech(segment.text) && !isHallucination(segment.text) && segment.end - segment.start >= minSeconds,
  );

  const segments = kept
    .sort((a, b) => a.start - b.start)
    .map((segment, index) =>
      makeSegment({
        id: index,
        start: Number(segment.start.toFixed(3)),
        end: Number(segment.end.toFixed(3)),
        text_en: normalizeText(segment.text),
        speaker: segment.speaker ?? 'speaker_0',
        words: segment.words ?? null,
        flags: segment.flags ?? [],
      }),
    );

  return markOverlaps(segments);
}

/** Aggregate used by the run report (SPEC FR-2). */
export function segmentsSummary(segments: Segment[]): {
  count: number;
  speechSeconds: number;
  speakers: string[];
  overlaps: number;
} {
  return {
    count: segments.length,
    speechSeconds: Number(segments.reduce((sum, s) => sum + (s.end - s.start), 0).toFixed(2)),
    speakers: [...new Set(segments.map((s) => s.speaker))].sort(),
    overlaps: segments.filter((s) => s.overlap).length,
  };
}
