import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { evaluateTimecodes, median, type GoldenSegment } from '../src/core/evaluate.js';
import { buildAtempoChain } from '../src/util/ffmpeg.js';
import { toSrt, formatTimestamp } from '../src/util/srt.js';
import { makeSegment } from '../src/core/types.js';

const golden = (items: Array<[number, number]>): GoldenSegment[] =>
  items.map(([start, end]) => ({ start, end }));

const actual = (items: Array<[number, number]>) =>
  items.map(([start, end], id) => makeSegment({ id, start, end, text_en: `s${id}` }));

describe('M1: сверка таймкодов с эталоном', () => {
  it('признаёт совпадение в пределах ±250 мс', () => {
    const report = evaluateTimecodes(golden([[1, 3], [5, 7]]), actual([[1.1, 3.2], [4.8, 7.1]]));
    expect(report.matched).toBe(2);
    expect(report.missing).toBe(0);
    expect(report.withinTolerance).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.maxStartDeviationMs).toBe(200);
  });

  it('проваливает критерий при отклонении больше допуска', () => {
    const report = evaluateTimecodes(golden([[1, 3]]), actual([[1.6, 3.1]]));
    expect(report.passed).toBe(false);
    expect(report.maxStartDeviationMs).toBe(600);
    expect(report.withinTolerance).toBe(0.5); // конец попал в допуск, начало — нет
  });

  it('считает пропущенные и лишние реплики', () => {
    const report = evaluateTimecodes(golden([[1, 2], [10, 11]]), actual([[1, 2], [4, 5], [6, 7]]));
    expect(report.matched).toBe(1);
    expect(report.missing).toBe(1);
    expect(report.spurious).toBe(2);
    expect(report.passed).toBe(false);
  });

  it('сопоставляет по максимальному пересечению, а не по порядку', () => {
    const report = evaluateTimecodes(golden([[10, 12]]), actual([[0, 1], [9.9, 12.1]]));
    expect(report.matches[0]!.actual!.id).toBe(1);
  });

  it('median работает на чётном и нечётном числе значений', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('fixtures/golden.json', () => {
  it('эталонная разметка валидна по контракту', async () => {
    const file = new URL('./fixtures/golden.json', import.meta.url);
    const data = JSON.parse(await readFile(file, 'utf8')) as { segments: GoldenSegment[] };
    expect(Array.isArray(data.segments)).toBe(true);
    expect(data.segments.length).toBeGreaterThan(0);
    for (const segment of data.segments) {
      expect(segment.end).toBeGreaterThan(segment.start);
      expect(segment.speaker).toMatch(/^speaker_\d+$/);
    }
  });
});

describe('FR-6: цепочка atempo для ffmpeg', () => {
  it('единичный темп не добавляет фильтров', () => {
    expect(buildAtempoChain(1)).toEqual([]);
  });

  it('темп в пределах 0.5–2.0 задаётся одним фильтром', () => {
    expect(buildAtempoChain(1.25)).toEqual(['atempo=1.25']);
    expect(buildAtempoChain(0.9)).toEqual(['atempo=0.9']);
  });

  it('темп вне диапазона раскладывается в цепочку', () => {
    const chain = buildAtempoChain(3);
    expect(chain.length).toBeGreaterThan(1);
    const product = chain.reduce((acc, f) => acc * Number(f.split('=')[1]), 1);
    expect(product).toBeCloseTo(3, 5);
  });

  it('отвергает бессмысленный темп', () => {
    expect(() => buildAtempoChain(0)).toThrow();
    expect(() => buildAtempoChain(-1)).toThrow();
  });
});

describe('Экспорт SRT', () => {
  it('форматирует таймкод по стандарту', () => {
    expect(formatTimestamp(0)).toBe('00:00:00,000');
    expect(formatTimestamp(3661.5)).toBe('01:01:01,500');
  });

  it('нумерует реплики с единицы и подставляет нужный язык', () => {
    const segments = [
      makeSegment({ id: 0, start: 0, end: 1, text_en: 'hello', text_ru: 'привет' }),
      makeSegment({ id: 1, start: 2, end: 3, text_en: 'world', text_ru: 'мир' }),
    ];
    const srt = toSrt(segments, 'ru');
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000\nпривет');
    expect(srt).toContain('2\n00:00:02,000 --> 00:00:03,000\nмир');
  });
});
