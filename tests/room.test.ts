import { describe, it, expect } from 'vitest';
import { availableSeconds, makeSegment, slotOf } from '../src/core/types.js';
import { parseConfig } from '../src/config/load.js';
import { roomFor } from '../src/stages/s3-translate.js';

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

// Одна и та же мерка раздаётся заказу перевода, сводке, корректирующему проходу
// и проверке модели. Расхождение между ними уже давало дефекты: реплику брали
// в правку по одному числу, а результат судили по другому.
describe('Общая мерка места', () => {
  const config = (over: Record<string, unknown> = {}) =>
    parseConfig({ alignment: { borrow_silence_ms: 1200, gap_ms: 50, ...over } }, 'test');

  it('совпадает с расчётом места по одной реплике', () => {
    const segments = [seg(0, 0, 2), seg(1, 10, 11)];
    const room = roomFor(config(), segments);
    expect(room(segments[0]!)).toBeCloseTo(availableSeconds(segments, 0, options), 3);
    expect(room(segments[1]!)).toBeCloseTo(availableSeconds(segments, 1, options), 3);
  });

  it('не зависит от порядка реплик в массиве', () => {
    const ordered = [seg(0, 0, 2), seg(1, 10, 11)];
    const shuffled = [ordered[1]!, ordered[0]!];
    expect(roomFor(config(), shuffled)(ordered[0]!)).toBeCloseTo(roomFor(config(), ordered)(ordered[0]!), 3);
  });

  it('запрет занимать паузу возвращает голый слот', () => {
    const segments = [seg(0, 0, 2), seg(1, 10, 11)];
    const room = roomFor(config({ borrow_silence_ms: 0 }), segments);
    expect(room(segments[0]!)).toBeCloseTo(slotOf(segments[0]!), 3);
  });
});
