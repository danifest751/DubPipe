import { describe, it, expect } from 'vitest';
import { findPauses, insertSilence, originalPauses, spreadPlan } from '../src/stages/s6-pauses.js';

/**
 * Недостающее время реплики раскладывается по паузам внутри неё, а не копится
 * дырой в конце и не добивается выдуманными словами.
 *
 * До этого выбор был из двух плохих: «Лиза.» превращалось в «Лиза, Лиза» либо
 * под ещё шевелящимися губами повисала тишина.
 */

const SR = 16_000;

/** Клип: чередование речи и тишины, длительности в секундах. */
const clip = (parts: Array<{ speech: boolean; seconds: number }>): Float32Array => {
  const total = parts.reduce((sum, part) => sum + Math.round(part.seconds * SR), 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    const length = Math.round(part.seconds * SR);
    if (part.speech) {
      for (let i = 0; i < length; i++) out[offset + i] = Math.sin((2 * Math.PI * 180 * i) / SR) * 0.5;
    }
    offset += length;
  }
  return out;
};

describe('паузы внутри клипа', () => {
  it('находит молчание между словами и не считает паузой края', () => {
    const samples = clip([
      { speech: false, seconds: 0.2 },
      { speech: true, seconds: 0.5 },
      { speech: false, seconds: 0.3 },
      { speech: true, seconds: 0.5 },
      { speech: false, seconds: 0.4 },
    ]);
    const pauses = findPauses(samples, SR);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.start).toBeCloseTo(0.7, 1);
    expect(pauses[0]!.end).toBeCloseTo(1.0, 1);
  });

  it('стык слов паузой не считается', () => {
    const samples = clip([
      { speech: true, seconds: 0.4 },
      { speech: false, seconds: 0.04 },
      { speech: true, seconds: 0.4 },
    ]);
    expect(findPauses(samples, SR)).toEqual([]);
  });

  it('стыки слов по 100–150 мс паузами не считаются', () => {
    // Настоящий случай: «О да, теперь ты мой» — 1.3 с речи, а прежний порог в
    // 90 мс нашёл там три «паузы» и получил полторы секунды тишины внутри.
    const samples = clip([
      { speech: true, seconds: 0.35 },
      { speech: false, seconds: 0.16 },
      { speech: true, seconds: 0.12 },
      { speech: false, seconds: 0.1 },
      { speech: true, seconds: 0.12 },
      { speech: false, seconds: 0.12 },
      { speech: true, seconds: 0.34 },
    ]);
    expect(findPauses(samples, SR)).toEqual([]);
  });

  it('у сплошной речи пауз нет', () => {
    expect(findPauses(clip([{ speech: true, seconds: 1 }]), SR)).toEqual([]);
  });
});

describe('паузы оригинала по словам', () => {
  it('берёт промежутки длиннее 300 мс — так паузу считают и в работах по дубляжу', () => {
    const words = [
      { word: 'You', start: 0, end: 0.3 },
      { word: 'killed', start: 0.32, end: 0.7 },
      { word: 'three', start: 1.15, end: 1.4 },
    ];
    const pauses = originalPauses(words);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toEqual({ start: 0.7, end: 1.15 });
  });

  it('без слов и на одном слове пауз нет', () => {
    expect(originalPauses(null)).toEqual([]);
    expect(originalPauses([{ word: 'Yes', start: 0, end: 0.4 }])).toEqual([]);
  });
});

describe('раскладка недостающего времени', () => {
  const clipPauses = [
    { start: 0.5, end: 0.7 },
    { start: 1.5, end: 1.7 },
  ];

  it('делит поровну, когда оригинал молчал иначе', () => {
    const plan = spreadPlan(clipPauses, [], 0.8);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.seconds).toBeCloseTo(0.4, 2);
    expect(plan[0]!.at).toBeCloseTo(0.6, 2);
    expect(plan[1]!.at).toBeCloseTo(1.6, 2);
  });

  it('делит по весу пауз оригинала, когда их столько же', () => {
    // В оригинале говорящий молчал вчетверо дольше во второй паузе — туда и
    // уходит время: пауза ставится там, где она была у него.
    const plan = spreadPlan(clipPauses, [{ start: 0, end: 0.1 }, { start: 1, end: 1.4 }], 0.5);
    expect(plan[0]!.seconds).toBeCloseTo(0.1, 2);
    expect(plan[1]!.seconds).toBeCloseTo(0.4, 2);
  });

  it('в одну паузу больше предела не кладёт: это уже обрыв реплики', () => {
    const plan = spreadPlan([{ start: 0.5, end: 0.7 }], [], 3, { maxPerPause: 0.5 });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.seconds).toBeCloseTo(0.5, 2);
  });

  it('больше заданного всего не кладёт, как бы много места ни было', () => {
    // Доля от длительности самой реплики: короткая фраза не должна утонуть
    // в паузах длиннее себя.
    const plan = spreadPlan(clipPauses, [], 5, { maxTotal: 0.5 });
    expect(plan.reduce((sum, item) => sum + item.seconds, 0)).toBeCloseTo(0.5, 2);
  });

  it('трогает не больше двух пауз, и самые длинные', () => {
    const many = [
      { start: 0.5, end: 0.6 },
      { start: 1.0, end: 1.4 },
      { start: 2.0, end: 2.5 },
    ];
    const plan = spreadPlan(many, [], 2);
    expect(plan).toHaveLength(2);
    expect(plan.map((item) => item.at)).toEqual([1.2, 2.25]);
  });

  it('без пауз в клипе и на крошечной нехватке не делает ничего', () => {
    expect(spreadPlan([], [], 1)).toEqual([]);
    expect(spreadPlan(clipPauses, [], 0.05)).toEqual([]);
  });
});

describe('вставка тишины в клип', () => {
  it('удлиняет клип ровно на запрошенное и не трогает звук', () => {
    const samples = clip([
      { speech: true, seconds: 0.5 },
      { speech: false, seconds: 0.2 },
      { speech: true, seconds: 0.5 },
    ]);
    const out = insertSilence(samples, SR, [{ at: 0.6, seconds: 0.3 }]);
    expect(out.length).toBe(samples.length + Math.round(0.3 * SR));
    // Речь до вставки осталась на месте, за ней — ноль.
    expect(out[Math.round(0.25 * SR)]).toBeCloseTo(samples[Math.round(0.25 * SR)]!, 5);
    expect(out[Math.round(0.7 * SR)]).toBe(0);
    // И речь после вставки не потерялась, просто сдвинулась. Смотрим окном:
    // в отдельно взятой точке синусоида может оказаться на нуле.
    const moved = Math.round((0.8 + 0.3) * SR);
    const loudest = Math.max(...[...out.subarray(moved, moved + 200)].map(Math.abs));
    expect(loudest).toBeGreaterThan(0.1);
  });

  it('пустой план оставляет клип нетронутым', () => {
    const samples = clip([{ speech: true, seconds: 0.3 }]);
    expect(insertSilence(samples, SR, [])).toBe(samples);
  });
});
