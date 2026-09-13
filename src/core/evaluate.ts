import type { Segment } from './types.js';

/**
 * Timecode accuracy against reference markup (SPEC M1: deviation ≤ ±250 ms).
 * Kept free of I/O so it can be unit-tested and reused by the CLI.
 */

export interface GoldenSegment {
  start: number;
  end: number;
  speaker?: string;
  text_en?: string;
}

export interface SegmentMatch {
  golden: GoldenSegment;
  actual: Segment | null;
  /** Every produced segment covering this reference replica, in time order. */
  group: Segment[];
  startDeviationMs: number | null;
  endDeviationMs: number | null;
}

export interface EvaluationReport {
  toleranceMs: number;
  matched: number;
  missing: number;
  spurious: number;
  /** Reference replicas that were split into several produced segments. */
  split: number;
  /** Share of matched boundaries within tolerance, 0..1. */
  withinTolerance: number;
  maxStartDeviationMs: number;
  maxEndDeviationMs: number;
  medianStartDeviationMs: number;
  passed: boolean;
  matches: SegmentMatch[];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

function overlapSeconds(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** A produced segment counts towards a reference replica only if it truly sits inside it. */
function belongsTo(reference: GoldenSegment, segment: Segment): boolean {
  const shared = overlapSeconds(reference, segment);
  if (shared <= 0) return false;
  const segmentLength = segment.end - segment.start;
  return shared >= Math.min(0.15, segmentLength * 0.5) || shared >= segmentLength * 0.5;
}

/**
 * Matches produced segments to reference replicas by time overlap, many-to-one:
 * splitting a reference replica at a real pause is legitimate output, so the
 * group's outer edges are what gets compared against the reference boundaries.
 */
export function evaluateTimecodes(
  golden: GoldenSegment[],
  actual: Segment[],
  toleranceMs = 250,
): EvaluationReport {
  const used = new Set<number>();
  const matches: SegmentMatch[] = [];

  for (const reference of golden) {
    const group: Segment[] = [];
    actual.forEach((segment, index) => {
      if (used.has(index) || !belongsTo(reference, segment)) return;
      used.add(index);
      group.push(segment);
    });

    if (group.length === 0) {
      matches.push({ golden: reference, actual: null, group: [], startDeviationMs: null, endDeviationMs: null });
      continue;
    }

    group.sort((a, b) => a.start - b.start);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    matches.push({
      golden: reference,
      actual: first,
      group,
      startDeviationMs: Math.round((first.start - reference.start) * 1000),
      endDeviationMs: Math.round((last.end - reference.end) * 1000),
    });
  }

  const matched = matches.filter((m) => m.actual !== null);
  const startDeviations = matched.map((m) => Math.abs(m.startDeviationMs!));
  const endDeviations = matched.map((m) => Math.abs(m.endDeviationMs!));
  const boundaries = [...startDeviations, ...endDeviations];
  const within = boundaries.filter((value) => value <= toleranceMs).length;

  return {
    toleranceMs,
    matched: matched.length,
    split: matched.filter((m) => m.group.length > 1).length,
    missing: matches.length - matched.length,
    spurious: actual.length - used.size,
    withinTolerance: boundaries.length ? within / boundaries.length : 0,
    // reduce вместо Math.max(...массив): spread на десятках тысяч элементов
    // переполняет стек — на длинном видео реплик может быть именно столько.
    maxStartDeviationMs: startDeviations.reduce((max, value) => Math.max(max, value), 0),
    maxEndDeviationMs: endDeviations.reduce((max, value) => Math.max(max, value), 0),
    medianStartDeviationMs: Math.round(median(startDeviations)),
    passed:
      matched.length === golden.length &&
      boundaries.every((value) => value <= toleranceMs),
    matches,
  };
}

export function formatEvaluation(report: EvaluationReport): string {
  const lines = [
    `Реплик в эталоне: ${report.matched + report.missing}, сопоставлено: ${report.matched}` +
      (report.missing ? `, пропущено: ${report.missing}` : '') +
      (report.spurious ? `, лишних: ${report.spurious}` : '') +
      (report.split ? `, разбито на несколько: ${report.split}` : ''),
    `Границы в допуске ±${report.toleranceMs} мс: ${(report.withinTolerance * 100).toFixed(1)}%`,
    `Отклонение начала: медиана ${report.medianStartDeviationMs} мс, максимум ${report.maxStartDeviationMs} мс`,
    `Отклонение конца: максимум ${report.maxEndDeviationMs} мс`,
    report.passed ? 'Критерий M1 выполнен' : 'Критерий M1 НЕ выполнен',
  ];
  return lines.join('\n');
}
