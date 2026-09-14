import { describe, it, expect } from 'vitest';
import { availableSeconds, makeSegment, slotOf } from '../src/core/types.js';

const seg = (id: number, start: number, end: number) =>
  makeSegment({ id, start, end, text_en: `line ${id}` });

const options = { borrowSeconds: 1.2, gapSeconds: 0.05 };

describe('Сколько места отведено реплике', () => {
  it('к слоту добавляется пауза после реплики', () => {
    const segments = [seg(0, 0, 2), seg(1, 10, 11)];
    expect(availableSeconds(segments, 0, options)).toBeCloseTo(3.2, 3);
  });

  it('занимается не больше разрешённого', () => {
    // Перед долгой тишиной реплика не должна растянуться на всю её длину.
    const segments = [seg(0, 0, 2), seg(1, 60, 61)];
    expect(availableSeconds(segments, 0, options)).toBeCloseTo(3.2, 3);
  });

  it('до следующей реплики остаётся зазор', () => {
    const segments = [seg(0, 0, 2), seg(1, 2.3, 3)];
    expect(availableSeconds(segments, 0, options)).toBeCloseTo(2.25, 3);
  });

  it('вплотную стоящая следующая реплика не даёт ничего занять', () => {
    const segments = [seg(0, 0, 2), seg(1, 2, 3)];
    expect(availableSeconds(segments, 0, options)).toBeCloseTo(slotOf(segments[0]!), 3);
  });

  it('последней реплике пауза берётся из запаса', () => {
    expect(availableSeconds([seg(0, 0, 2)], 0, options)).toBeCloseTo(3.2, 3);
  });

  it('нулевое разрешение оставляет голый слот', () => {
    const segments = [seg(0, 0, 2), seg(1, 10, 11)];
    expect(availableSeconds(segments, 0, { borrowSeconds: 0, gapSeconds: 0.05 })).toBeCloseTo(2, 3);
  });
});
