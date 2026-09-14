import { describe, it, expect } from 'vitest';
import { availableSeconds, makeSegment, slotOf } from '../src/core/types.js';
import { parseConfig } from '../src/config/load.js';
import { fitRuler, lengthVerdict, roomFor, type FitRuler } from '../src/stages/s3-translate.js';
import { planAlignment } from '../src/stages/s6-align.js';

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

describe('Мерка длины для интерфейса', () => {
  const config = (over: Record<string, unknown> = {}) =>
    parseConfig({ alignment: { borrow_silence_ms: 1200, gap_ms: 50, ...over } }, 'test');

  /** Рабочий каталог понарошку: замера темпа для этого голоса нет. */
  const workspace = { root: 'ROOT', file: (name: string) => `WS/${name}`, readJson: async () => null } as never;

  /**
   * Дословно то, что делает таблица реплик в `src/ui/public/app.js`.
   * Если мерка разойдётся с конвейером, разойдутся и эти два вердикта.
   */
  const uiVerdict = (ruler: FitRuler, segment: ReturnType<typeof seg>, textRu: string): boolean => {
    const room = ruler.room[segment.id] ?? segment.end - segment.start;
    const estimated = ruler.overheadSeconds + textRu.trim().length / ruler.charsPerSecond;
    return Math.abs(estimated - room) <= Math.max(room * ruler.tolerance, ruler.toleranceFloorSeconds);
  };

  it('отдаёт то же место, которым меряет перевод', async () => {
    const segments = [seg(0, 0, 2), seg(1, 10, 11)];
    const ruler = await fitRuler(workspace, config(), segments);
    const room = roomFor(config(), segments);
    expect(ruler.room[0]).toBeCloseTo(room(segments[0]!), 3);
    expect(ruler.room[1]).toBeCloseTo(room(segments[1]!), 3);
  });

  it('отдаёт темп с надбавкой и допуск из настроек', async () => {
    const settings = config();
    const ruler = await fitRuler(workspace, settings, [seg(0, 0, 2)]);
    expect(ruler.charsPerSecond).toBe(settings.translate.chars_per_second);
    expect(ruler.overheadSeconds).toBe(settings.translate.speech_overhead_seconds);
    expect(ruler.tolerance).toBe(settings.translate.length_tolerance);
    expect(ruler.toleranceFloorSeconds).toBeCloseTo(settings.translate.length_tolerance_floor_ms / 1000, 6);
  });

  it('интерфейс выносит тот же вердикт, что и стадия перевода', async () => {
    const settings = config();
    const segments = [seg(0, 0, 2), seg(1, 10, 11)];
    const ruler = await fitRuler(workspace, settings, segments);
    const room = roomFor(settings, segments);

    for (const chars of [4, 12, 24, 36, 48, 60, 90]) {
      const text = 'а'.repeat(chars);
      for (const segment of segments) {
        const stage = lengthVerdict(
          text,
          room(segment),
          settings.translate.chars_per_second,
          settings.translate.length_tolerance,
          settings.translate.length_tolerance_floor_ms / 1000,
          settings.translate.speech_overhead_seconds,
        ).withinTolerance;
        expect(uiVerdict(ruler, segment, text)).toBe(stage);
      }
    }
  });

  it('реплика, которой хватает занятой паузы, не помечается длинной', async () => {
    // Прежняя мерка интерфейса — голый слот и темп без надбавки — кричала
    // именно здесь: место есть, а таблица красила реплику красным.
    const segments = [seg(0, 0, 2), seg(1, 10, 11)];
    const ruler = await fitRuler(workspace, config(), segments);
    const text = 'а'.repeat(Math.round((3.2 - 0.51) * 17.8));
    expect(uiVerdict(ruler, segments[0]!, text)).toBe(true);
  });
});

describe('Одна формула места на весь конвейер', () => {
  const settings = () => parseConfig({ alignment: { borrow_silence_ms: 1200, gap_ms: 50 } }, 'test');

  it('укладка отводит реплике ровно то же место, что заказал перевод', () => {
    // Формула жила в трёх копиях: в общей функции, в укладке и в предупреждении
    // синтеза. Пока они совпадали дословно — расхождения не было; разъехаться
    // им ничего не мешало, а такие расхождения и дали половину дефектов.
    const config = settings();
    const segments = [seg(0, 0, 2), seg(1, 3, 4), seg(2, 4.2, 6), seg(3, 20, 21)];
    const room = roomFor(config, segments);
    const plan = planAlignment(segments, {
      minTempo: config.alignment.min_tempo,
      maxTempo: config.alignment.max_tempo,
      gapMs: config.alignment.gap_ms,
      borrowSilenceMs: config.alignment.borrow_silence_ms,
      maxShiftMs: config.alignment.max_shift_ms,
      driftResetGapMs: config.alignment.drift_reset_gap_ms,
    });

    for (const item of plan) {
      const segment = segments.find((candidate) => candidate.id === item.id)!;
      expect(item.slot).toBeCloseTo(room(segment), 3);
    }
  });
});
