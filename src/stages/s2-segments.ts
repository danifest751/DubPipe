import { makeSegment, type Segment, type SegmentFlag, type WordTiming } from '../core/types.js';

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
  const { maxGapMs = 700, maxSeconds = 15 } = options;
  const segments: RawSegment[] = [];
  let current: WordTiming[] = [];

  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      text: normalizeText(current.map((w) => w.word).join(' ')),
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
 * Full S2 post-processing: refine edges → drop noise and sub-0.4 s fragments →
 * split over-long replicas → renumber → flag overlaps.
 */
export function buildSegments(raw: RawSegment[], options: BuildOptions = {}): Segment[] {
  const { vadWindowMs = 400, minSeconds = MIN_SEGMENT_SECONDS, maxSeconds = MAX_SEGMENT_SECONDS } = options;

  const refined = raw
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .map((segment) => (vadWindowMs > 0 ? refineBoundaries(segment, vadWindowMs) : segment));

  const split = refined.flatMap((segment) => splitLongSegment(segment, maxSeconds));

  const kept = split.filter(
    (segment) => !isNonSpeech(segment.text) && segment.end - segment.start >= minSeconds,
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
