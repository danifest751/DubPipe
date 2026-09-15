import { describe, it, expect } from 'vitest';
import { buildPhraseRequest, parsePhraseResponse, sourcePhrases, speakable, splitTranslation } from '../src/stages/s5-phrases.js';
import { applyReview } from '../src/stages/review.js';
import { makeSegment } from '../src/core/types.js';

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

  it('немой кусок отменяет разбиение целиком', () => {
    /*
     * Настоящий случай, на нём встала озвучка ролика про локальные модели:
     * «специальную команду — ollama serve.» резалась по тире, и второму куску
     * доставалась одна латиница. Русский синтезатор её не читает — он ответил
     * пустой ошибкой `ValueError:`, и стадия упала, хотя целиком эта реплика
     * произносится прекрасно.
     */
    expect(splitTranslation('специальную команду — ollama serve', twoPhrases)).toBeNull();
    // Та же реплика с русским во втором куске делится как прежде.
    const plan = splitTranslation('специальную команду — запусти сервер', twoPhrases);
    expect(plan!.parts).toEqual(['специальную команду —', 'запусти сервер']);
  });

  it('огрызков не делает и одну фразу не делит', () => {
    expect(splitTranslation('Да, нет', twoPhrases)).toBeNull();
    expect(splitTranslation('Мира больше нет', [{ start: 0, end: 1, pauseAfter: 0 }])).toBeNull();
  });
});

describe('разметка фраз моделью', () => {
  const asked = () =>
    new Map([
      [
        7,
        {
          id: 7,
          ru: 'С этого момента клан Сиртр переходит под власть Варака',
          phrases: [1.26, 0.58],
          pauses: [0.42],
        },
      ],
    ]);

  it('в запрос попадают только реплики с паузой внутри', () => {
    const lines = buildPhraseRequest([
      { id: 1, text_ru: 'Без пауз', words: [{ word: 'No', start: 0, end: 0.3 }, { word: 'pause', start: 0.32, end: 0.6 }] },
      {
        id: 2,
        text_ru: 'С паузой внутри',
        words: [{ word: 'With', start: 0, end: 0.3 }, { word: 'pause', start: 0.8, end: 1.1 }],
      },
      { id: 3, text_ru: null, words: null },
    ]);
    expect(lines.map((line) => line.id)).toEqual([2]);
    expect(lines[0]!.pauses).toEqual([0.5]);
  });

  it('берёт разбиение, которое складывается обратно в тот же текст', () => {
    const plans = parsePhraseResponse(
      '{"items":[{"id":7,"parts":["С этого момента","клан Сиртр переходит под власть Варака"]}]}',
      asked(),
    );
    expect(plans.get(7)!.parts).toHaveLength(2);
    expect(plans.get(7)!.pauses).toEqual([0.42]);
  });

  it('переписанный текст отбрасывается целиком', () => {
    // Попросили разделить — модель заодно «улучшила» слова. Такое молча уедет
    // в фильм, если не сверять: куски обязаны складываться в исходную реплику.
    const plans = parsePhraseResponse(
      '{"items":[{"id":7,"parts":["С этой минуты","клан Сиртр переходит к Вараку"]}]}',
      asked(),
    );
    expect(plans.size).toBe(0);
  });

  it('пустые куски, лишние куски и чужие реплики не берутся', () => {
    expect(parsePhraseResponse('{"items":[{"id":7,"parts":["С этого момента",""]}]}', asked()).size).toBe(0);
    expect(parsePhraseResponse('{"items":[{"id":7,"parts":["С","этого","момента"]}]}', asked()).size).toBe(0);
    expect(parsePhraseResponse('{"items":[{"id":99,"parts":["а","б"]}]}', asked()).size).toBe(0);
  });

  it('немой кусок от модели тоже не берётся', () => {
    const asked = new Map([
      [7, { id: 7, ru: 'ставим ollama serve и ждём', phrases: [1.2, 0.6], pauses: [0.4] }],
    ]);
    expect(parsePhraseResponse('{"items":[{"id":7,"parts":["ставим","ollama serve и ждём"]}]}', asked).size).toBe(1);
    expect(parsePhraseResponse('{"items":[{"id":7,"parts":["ставим ollama serve","и ждём"]}]}', asked).size).toBe(1);
    expect(parsePhraseResponse('{"items":[{"id":7,"parts":["ollama serve","и ждём ставим"]}]}', asked).size).toBe(0);
  });

  it('ответ без JSON — это ошибка, а не молчаливый пропуск', () => {
    expect(() => parsePhraseResponse('не могу', asked())).toThrow();
  });
});

describe('что синтезатору есть произнести', () => {
  it('русская буква — есть, латиница и цифры — нет', () => {
    expect(speakable('Когда её запустишь')).toBe(true);
    expect(speakable('Ollama')).toBe(false);
    expect(speakable('2026')).toBe(false);
    expect(speakable('—')).toBe(false);
    expect(speakable('Ollama и порт')).toBe(true);
  });
});

describe('разметка живёт ровно столько, сколько текст, к которому относится', () => {
  it('правка рецензии уносит разметку с собой', () => {
    // Иначе синтез разрежет новый текст по границам старого — и произнесёт
    // куски того, что рецензия только что исправила.
    const segment = makeSegment({
      id: 1,
      start: 0,
      end: 3,
      text_en: 'line',
      text_ru: 'Ты начал вести себя странно',
      phrases: ['Ты начал', 'вести себя странно'],
    });
    const outcome = applyReview([segment], [{ id: 1, text_ru: 'Ты начала вести себя странно' }], {
      room: (line) => line.end - line.start,
      charsPerSecond: 15,
      overheadSeconds: 0.26,
      tolerance: 0.15,
      toleranceFloorSeconds: 0.25,
      allowWorseFit: false,
      maxChangesShare: 0.5,
    });
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.segments[0]!.phrases).toBeNull();
  });
});
