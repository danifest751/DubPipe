import { describe, it, expect } from 'vitest';
import {
  buildSegments,
  isNonSpeech,
  markOverlaps,
  refineBoundaries,
  splitLongSegment,
  segmentsSummary,
  MIN_SEGMENT_SECONDS,
  type RawSegment,
} from '../src/stages/s2-segments.js';
import { makeSegment, type WordTiming } from '../src/core/types.js';

/** Builds evenly spaced word timings, optionally with a pause before one word. */
function words(count: number, start: number, step: number, pauseBefore?: { index: number; gap: number }): WordTiming[] {
  const result: WordTiming[] = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    if (pauseBefore && pauseBefore.index === i) cursor += pauseBefore.gap;
    result.push({ word: `w${i}`, start: cursor, end: cursor + step * 0.8 });
    cursor += step;
  }
  return result;
}

describe('FR-2: отбрасывание неречевых сегментов', () => {
  it('распознаёт служебные пометки как неречь', () => {
    expect(isNonSpeech('[MUSIC]')).toBe(true);
    expect(isNonSpeech('(applause)')).toBe(true);
    expect(isNonSpeech('[BLANK_AUDIO]')).toBe(true);
    expect(isNonSpeech('   ')).toBe(true);
    expect(isNonSpeech('...')).toBe(true);
    expect(isNonSpeech('Hello there')).toBe(false);
  });

  it('отбрасывает реплики короче 0.4 с', () => {
    const raw: RawSegment[] = [
      { start: 0, end: 0.3, text: 'too short' },
      { start: 1, end: 2, text: 'long enough' },
    ];
    const segments = buildSegments(raw);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text_en).toBe('long enough');
    expect(segments[0]!.end - segments[0]!.start).toBeGreaterThanOrEqual(MIN_SEGMENT_SECONDS);
  });
});

describe('FR-2: уточнение границ по word-таймкодам', () => {
  it('подтягивает границы к первому и последнему слову внутри окна', () => {
    const segment: RawSegment = {
      start: 10,
      end: 13,
      text: 'a b',
      words: [
        { word: 'a', start: 10.2, end: 10.5 },
        { word: 'b', start: 12.6, end: 12.8 },
      ],
    };
    const refined = refineBoundaries(segment, 400);
    expect(refined.start).toBeCloseTo(10.2, 3);
    expect(refined.end).toBeCloseTo(12.8, 3);
  });

  it('не двигает границу, если коррекция выходит за окно', () => {
    const segment: RawSegment = {
      start: 10,
      end: 13,
      text: 'a b',
      words: [
        { word: 'a', start: 11.5, end: 11.7 },
        { word: 'b', start: 12.0, end: 12.2 },
      ],
    };
    // Начало слова 11.5 отстоит от 10 на 1.5 с, конец 12.2 от 13 — на 0.8 с;
    // обе коррекции больше окна ±400 мс, поэтому границы остаются исходными.
    const refined = refineBoundaries(segment, 400);
    expect(refined.start).toBe(10);
    expect(refined.end).toBe(13);
  });

  it('подтягивает только ту границу, что попала в окно', () => {
    const segment: RawSegment = {
      start: 10,
      end: 13,
      text: 'a b',
      words: [
        { word: 'a', start: 11.5, end: 11.7 },
        { word: 'b', start: 12.7, end: 12.85 },
      ],
    };
    const refined = refineBoundaries(segment, 400);
    expect(refined.start).toBe(10);
    expect(refined.end).toBeCloseTo(12.85, 3);
  });

  it('оставляет сегмент как есть без word-таймкодов', () => {
    const segment: RawSegment = { start: 5, end: 7, text: 'no words' };
    expect(refineBoundaries(segment, 400)).toEqual(segment);
  });
});

describe('FR-2: разбиение реплик длиннее 30 с', () => {
  it('режет по паузе больше 400 мс', () => {
    const segment: RawSegment = {
      start: 0,
      end: 40,
      text: 'long',
      words: words(40, 0, 1, { index: 20, gap: 0.6 }),
    };
    const parts = splitLongSegment(segment);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.end - part.start).toBeLessThanOrEqual(30);
  });

  it('понижает порог паузы, когда пауз > 400 мс нет', () => {
    const segment: RawSegment = {
      start: 0,
      end: 40,
      text: 'long',
      words: words(40, 0, 1, { index: 20, gap: 0.2 }),
    };
    const parts = splitLongSegment(segment);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.end - part.start).toBeLessThanOrEqual(30);
  });

  it('режет принудительно, когда пауз нет вовсе, и помечает флагом', () => {
    // Words butt up against each other: no gap can ever exceed a threshold.
    const tight: WordTiming[] = Array.from({ length: 40 }, (_, i) => ({
      word: `w${i}`,
      start: i,
      end: i + 1,
    }));
    const segment: RawSegment = { start: 0, end: 40, text: 'x', words: tight };
    const parts = splitLongSegment(segment);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.some((p) => p.flags?.includes('force_split'))).toBe(true);
    for (const part of parts) expect(part.end - part.start).toBeLessThanOrEqual(30);
  });

  // Регрессия: на реальном эпизоде whisper выдал одно «слово» длиной в минуту
  // на музыкальном вступлении, и разбиение уходило в бесконечную рекурсию —
  // «Maximum call stack size exceeded» на стадии распознавания.
  it('одно слово длиннее предела возвращается как есть, а не роняет стек', () => {
    const segment: RawSegment = { start: 0, end: 60, text: 'Music', words: [{ word: 'Music', start: 0, end: 60 }] };
    expect(splitLongSegment(segment)).toEqual([segment]);
  });

  it('один токен без word-таймкодов тоже неделим', () => {
    const segment: RawSegment = { start: 0, end: 60, text: 'Music' };
    expect(splitLongSegment(segment)).toEqual([segment]);
  });

  it('длинное слово внутри реплики отделяется от остальных и остаётся целым', () => {
    const segment: RawSegment = {
      start: 0,
      end: 60,
      text: 'Intro Music',
      words: [
        { word: 'Intro', start: 0, end: 5 },
        { word: 'Music', start: 5, end: 60 },
      ],
    };
    const parts = splitLongSegment(segment);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.text).toBe('Intro');
    expect(parts[1]!.text).toBe('Music');
    expect(parts[1]!.end - parts[1]!.start).toBeCloseTo(55, 3);
  });

  it('не трогает реплики короче предела', () => {
    const segment: RawSegment = { start: 0, end: 12, text: 'fine', words: words(12, 0, 1) };
    expect(splitLongSegment(segment)).toEqual([segment]);
  });
});

describe('§8: флаг overlap', () => {
  it('помечает обе перекрывающиеся реплики', () => {
    const segments = [
      makeSegment({ id: 0, start: 0, end: 3, text_en: 'first' }),
      makeSegment({ id: 1, start: 2.5, end: 5, text_en: 'second' }),
      makeSegment({ id: 2, start: 6, end: 7, text_en: 'third' }),
    ];
    const marked = markOverlaps(segments);
    expect(marked[0]!.overlap).toBe(true);
    expect(marked[1]!.overlap).toBe(true);
    expect(marked[2]!.overlap).toBe(false);
  });
});

describe('S2: сборка итоговых сегментов', () => {
  it('сортирует, перенумеровывает и заполняет контракт §5.1', () => {
    const raw: RawSegment[] = [
      { start: 5, end: 6.5, text: 'second' },
      { start: 1, end: 2.5, text: 'first' },
      { start: 3, end: 3.2, text: 'dropped: too short' },
      { start: 8, end: 9, text: '[MUSIC]' },
    ];
    const segments = buildSegments(raw);
    expect(segments.map((s) => s.id)).toEqual([0, 1]);
    expect(segments.map((s) => s.text_en)).toEqual(['first', 'second']);

    const first = segments[0]!;
    expect(first.text_ru).toBeNull();
    expect(first.tts_file).toBeNull();
    expect(first.tempo).toBeNull();
    expect(first.speaker).toBe('speaker_0');
    expect(first.retranslate_count).toBe(0);
    expect(first.flags).toEqual([]);
  });

  it('считает сводку по репликам', () => {
    const segments = buildSegments([
      { start: 0, end: 2, text: 'one', speaker: 'speaker_0' },
      { start: 3, end: 4, text: 'two', speaker: 'speaker_1' },
    ]);
    const summary = segmentsSummary(segments);
    expect(summary.count).toBe(2);
    expect(summary.speechSeconds).toBe(3);
    expect(summary.speakers).toEqual(['speaker_0', 'speaker_1']);
    expect(summary.overlaps).toBe(0);
  });
});
