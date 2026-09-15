import { describe, it, expect } from 'vitest';
import { sourcePhrases, splitTranslation } from '../src/stages/s5-phrases.js';

/**
 * Разбиение перевода по ритму оригинала — та самая «prosodic alignment» из
 * работ по автоматическому дубляжу: реплика режется по паузам говорящего,
 * перевод делится на столько же кусков, каждый озвучивается отдельно.
 *
 * Проверяется здесь не красота разбиения — её решает материал, — а то, что
 * режется только по знакам препинания, что каждой паузе оригинала достаётся
 * знак с её места и что при нехватке знаков разбиение честно не делается.
 */

const word = (w: string, start: number, end: number) => ({ word: w, start, end });

describe('фразы оригинала', () => {
  it('режет по молчанию длиннее 300 мс', () => {
    const phrases = sourcePhrases([
      word('You', 0, 0.3),
      word('killed', 0.32, 0.7),
      word('three', 1.15, 1.4),
      word('of', 1.42, 1.5),
    ]);
    expect(phrases).toHaveLength(2);
    expect(phrases[0]).toEqual({ start: 0, end: 0.7, pauseAfter: 0.45 });
    expect(phrases[1]).toEqual({ start: 1.15, end: 1.5, pauseAfter: 0 });
  });

  it('без пауз фраз нет: делить нечего', () => {
    expect(sourcePhrases([word('We', 0, 0.2), word('can', 0.22, 0.5)])).toEqual([]);
    expect(sourcePhrases(null)).toEqual([]);
    expect(sourcePhrases([word('Yes', 0, 0.4)])).toEqual([]);
  });
});

describe('разбиение перевода', () => {
  const twoPhrases = [
    { start: 0, end: 1, pauseAfter: 0.5 },
    { start: 1.5, end: 2.5, pauseAfter: 0 },
  ];

  it('режет по знаку препинания и несёт паузу оригинала', () => {
    const plan = splitTranslation('Мира больше нет, всё кончено', twoPhrases);
    expect(plan!.parts).toEqual(['Мира больше нет,', 'всё кончено']);
    expect(plan!.pauses).toEqual([0.5]);
  });

  it('без знаков препинания не режет вовсе', () => {
    // «С этого момента клан | Сиртр» — именно так выглядел разрез по длине, и
    // это слышно как заикание. Лучше не делить.
    expect(splitTranslation('С этого момента клан Сиртр переходит под власть Варака', twoPhrases)).toBeNull();
    expect(splitTranslation('Вы совершаете очень серьёзную ошибку', twoPhrases)).toBeNull();
  });

  it('паузе из середины реплики достаётся знак из середины перевода', () => {
    const three = [
      { start: 0, end: 1, pauseAfter: 0.4 },
      { start: 1.4, end: 2.4, pauseAfter: 0.35 },
      { start: 2.75, end: 3.75, pauseAfter: 0 },
    ];
    const plan = splitTranslation('Он ушёл на рассвете, никого не предупредив, и больше не вернулся', three);
    expect(plan!.parts).toEqual(['Он ушёл на рассвете,', 'никого не предупредив,', 'и больше не вернулся']);
    expect(plan!.pauses).toEqual([0.4, 0.35]);
  });

  it('знаков меньше, чем пауз — берём сколько есть', () => {
    const three = [
      { start: 0, end: 1, pauseAfter: 0.4 },
      { start: 1.4, end: 2.4, pauseAfter: 0.35 },
      { start: 2.75, end: 3.75, pauseAfter: 0 },
    ];
    const plan = splitTranslation('Вы сами виноваты! Сами во всём виноваты', three);
    expect(plan!.parts).toHaveLength(2);
    expect(plan!.pauses).toHaveLength(1);
  });

  it('огрызков не делает и одну фразу не делит', () => {
    expect(splitTranslation('Да, нет', twoPhrases)).toBeNull();
    expect(splitTranslation('Мира больше нет', [{ start: 0, end: 1, pauseAfter: 0 }])).toBeNull();
  });
});
