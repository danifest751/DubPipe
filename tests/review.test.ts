import { describe, it, expect } from 'vitest';
import { makeSegment, type Segment } from '../src/core/types.js';
import {
  applyReview,
  buildJournal,
  buildRefitLines,
  buildReviewLines,
  checksSection,
  parseReviewResponse,
  reviewChunks,
  type ApplyReviewOptions,
} from '../src/stages/review.js';

/**
 * Финальная рецензия правит то, чего не видно внутри пакета из десяти реплик:
 * имя героини в трёх написаниях, мужской род у женского персонажа,
 * непереведённый кусок. Всё это замечено на реальном материале.
 *
 * Проверяется здесь не качество правок — его решает модель, — а то, что
 * конвейер принимает их с двумя предохранителями: правка не должна укладываться
 * хуже прежней, а рецензия, переписавшая полфильма, не принимается вовсе.
 */

const line = (id: number, ru: string, seconds = 3): Segment =>
  makeSegment({ id, start: id * 10, end: id * 10 + seconds, text_en: `line ${id}`, text_ru: ru });

/** Мерка та же, что у стадии: время реплики плюс темп речи. */
const options = (over: Partial<ApplyReviewOptions> = {}): ApplyReviewOptions => ({
  room: (segment) => segment.end - segment.start,
  charsPerSecond: 15,
  overheadSeconds: 0.26,
  tolerance: 0.15,
  toleranceFloorSeconds: 0.25,
  allowWorseFit: false,
  maxChangesShare: 0.5,
  ...over,
});

describe('разбор ответа рецензии', () => {
  it('берёт только известные реплики и непустой текст', () => {
    const raw = '{"changes":[{"id":1,"text_ru":"Эва","reason":"имя"},{"id":99,"text_ru":"чужая"},{"id":2,"text_ru":""}]}';
    const changes = parseReviewResponse(raw, new Set([1, 2]));
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual({ id: 1, text_ru: 'Эва', reason: 'имя' });
    // Пустая строка доходит до применения и отбрасывается там, с указанием причины.
    expect(changes[1]!.text_ru).toBe('');
  });

  it('пустой список правок — нормальный ответ, а не ошибка', () => {
    expect(parseReviewResponse('{"changes":[]}', new Set([1]))).toEqual([]);
  });

  it('одна реплика — одна правка: повтор отбрасывается', () => {
    const raw = '{"changes":[{"id":1,"text_ru":"первая"},{"id":1,"text_ru":"вторая"}]}';
    expect(parseReviewResponse(raw, new Set([1]))).toEqual([{ id: 1, text_ru: 'первая' }]);
  });

  it('ответ без массива changes отвергается с понятной причиной', () => {
    expect(() => parseReviewResponse('{"items":[]}', new Set([1]))).toThrow('нет массива changes');
    expect(() => parseReviewResponse('не json вовсе', new Set([1]))).toThrow('нет JSON');
  });
});

describe('применение правок рецензии', () => {
  it('исправленный род принимается', () => {
    const segments = [line(1, 'Ты начал вести себя странно')];
    const outcome = applyReview(segments, [{ id: 1, text_ru: 'Ты начала вести себя странно' }], options());
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.segments[0]!.text_ru).toBe('Ты начала вести себя странно');
  });

  it('правка, которая укладывается хуже, не принимается', () => {
    // Реплика на 2 с при 15 знаках в секунду — это около 26 знаков.
    const segments = [line(1, 'Короткая реплика.', 2)];
    const tooLong = 'Совершенно непомерно длинная реплика, которая ни в какое время не поместится никогда';
    const outcome = applyReview(segments, [{ id: 1, text_ru: tooLong }], options());
    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected[0]!.why).toBe('worse_fit');
    expect(outcome.segments[0]!.text_ru).toBe('Короткая реплика.');
  });

  it('с разрешения принимается и худшая по укладке', () => {
    const segments = [line(1, 'Короткая реплика.', 2)];
    const tooLong = 'Совершенно непомерно длинная реплика, которая ни в какое время не поместится никогда';
    const outcome = applyReview(segments, [{ id: 1, text_ru: tooLong }], options({ allowWorseFit: true }));
    expect(outcome.applied).toHaveLength(1);
  });

  it('правка реплики, которая и так не влезала, принимается, если стало не хуже', () => {
    const segments = [line(1, 'Очень длинная реплика, которая заведомо не помещается в своё время никак', 2)];
    const shorter = 'Длинная реплика, которая не помещается';
    const outcome = applyReview(segments, [{ id: 1, text_ru: shorter }], options());
    expect(outcome.applied).toHaveLength(1);
  });

  it('текст, совпавший с прежним, и чужой номер отбрасываются', () => {
    const segments = [line(1, 'Как есть')];
    const outcome = applyReview(
      segments,
      [
        { id: 1, text_ru: 'Как есть' },
        { id: 7, text_ru: 'ниоткуда' },
      ],
      options(),
    );
    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected.map((entry) => entry.why).sort()).toEqual(['same', 'unknown_id']);
  });

  /** Фильм из тридцати реплик: на таком объёме доля переписанного уже о чём-то говорит. */
  const film = () => Array.from({ length: 30 }, (unused, index) => line(index + 1, `Реплика ${index + 1}`));

  it('рецензия, переписавшая больше половины, отбрасывается целиком', () => {
    const segments = film();
    const changes = segments.map((segment) => ({ id: segment.id, text_ru: `${segment.text_ru} и ещё` }));
    const outcome = applyReview(segments, changes, options());
    expect(outcome.discarded).toBe(true);
    expect(outcome.applied).toEqual([]);
    // Реплики остались нетронутыми: это не правка, а новый перевод.
    expect(outcome.segments[0]!.text_ru).toBe('Реплика 1');
  });

  it('порог отбрасывания настраивается', () => {
    const segments = film();
    const changes = segments.map((segment) => ({ id: segment.id, text_ru: `${segment.text_ru}!` }));
    expect(applyReview(segments, changes, options({ maxChangesShare: 1 })).discarded).toBe(false);
  });

  it('на коротком куске предохранитель не срабатывает: доля там ничего не значит', () => {
    const segments = [line(1, 'Раз'), line(2, 'Два')];
    const changes = segments.map((segment) => ({ id: segment.id, text_ru: `${segment.text_ru}!` }));
    const outcome = applyReview(segments, changes, options());
    expect(outcome.discarded).toBe(false);
    expect(outcome.applied).toHaveLength(2);
  });
});

describe('что рецензент видит и как это режется', () => {
  it('в строку попадают пол говорящего, имя персонажа и нехватка места', () => {
    const segments = [line(1, 'Слишком длинная реплика, которая заведомо не помещается', 1)];
    segments[0]!.speaker = 'speaker_2';
    const lines = buildReviewLines(segments, {
      ...options(),
      speakers: { speaker_2: { gender: 'ж', f0: 176, voicedSeconds: 7.4 } },
      names: { speaker_2: 'Ева' },
    });
    expect(lines[0]!.gender).toBe('ж');
    expect(lines[0]!.name).toBe('Ева');
    expect(lines[0]!.over).toBeGreaterThan(0);
  });

  it('о недолёте рецензии не сообщают вовсе', () => {
    // Узнав, что реплика короче цели, она добивает её повтором сказанного —
    // на третьем эпизоде так вышло больше половины правок. Снизу длину добирает
    // подгонка S6, а пауза дешевле ускорения.
    const lines = buildReviewLines([line(1, 'Коротко.', 6)], { ...options(), speakers: {}, names: {} });
    expect(lines[0]!.over).toBe(0);
    expect(JSON.stringify(lines[0])).not.toContain('min_chars');
    expect(JSON.stringify(lines[0])).not.toContain('target_chars');
  });

  it('непереведённые реплики рецензенту не показываются', () => {
    const segments = [line(1, 'Есть перевод'), makeSegment({ id: 2, start: 0, end: 2, text_en: 'x', text_ru: null })];
    const lines = buildReviewLines(segments, { ...options(), speakers: {}, names: {} });
    expect(lines.map((entry) => entry.id)).toEqual([1]);
  });

  it('эпизод целиком идёт одним заходом, длинный фильм — с нахлёстом', () => {
    const short = Array.from({ length: 136 }, (unused, index) => index);
    expect(reviewChunks(short, 400, 10)).toHaveLength(1);

    const long = Array.from({ length: 1000 }, (unused, index) => index);
    const chunks = reviewChunks(long, 400, 10);
    expect(chunks.length).toBeGreaterThan(1);
    // Нахлёст нужен, чтобы на стыке был виден конец предыдущей сцены.
    expect(chunks[1]![0]).toBeLessThan(chunks[0]![chunks[0]!.length - 1]!);
    expect(chunks[chunks.length - 1]![chunks[chunks.length - 1]!.length - 1]).toBe(999);
  });
});

describe('список проверок в промпте', () => {
  const all = {
    gender: true, glossary: true, address: true, consistency: true,
    meaning: true, grammar: true, phrasing: true, length: true,
  };

  it('перечисляет только включённое', () => {
    const only = checksSection({ ...all, gender: false, address: false, consistency: false, meaning: false });
    expect(only).toContain('Имена и термины');
    expect(only).toContain('Длина');
    expect(only).not.toContain('Род.');
    expect(only).not.toContain('Ты и вы');
  });

  it('правила языка и строй фразы — отдельные проверки, не часть смысла', () => {
    // Рецензия правит текст, который произнесут вслух: падеж имени и калька с
    // оригинала слышны, даже когда смысл передан верно.
    const both = checksSection(all);
    expect(both).toContain('Правила языка');
    expect(both).toContain('Строй фразы');
    const without = checksSection({ ...all, grammar: false, phrasing: false });
    expect(without).not.toContain('Правила языка');
    expect(without).not.toContain('Строй фразы');
    expect(without).toContain('Смысл');
  });

  it('при всех выключенных честно говорит, что проверять нечего', () => {
    const none = checksSection(Object.fromEntries(Object.keys(all).map((name) => [name, false])) as typeof all);
    expect(none).toContain('все проверки отключены');
  });
});

describe('переспрос по правкам, не влезшим в слот', () => {
  const tooLong = 'Совершенно непомерно длинная правка, которая никак не помещается в своё время';

  it('собирает переспрос только по отклонённым за длину', () => {
    const segments = [line(1, 'Короткая реплика.', 2), line(2, 'Другая реплика.', 2)];
    const outcome = applyReview(
      segments,
      [
        { id: 1, text_ru: tooLong, reason: 'род говорящего' },
        { id: 2, text_ru: 'Другая реплика.' },
        { id: 99, text_ru: 'ниоткуда' },
      ],
      options(),
    );
    const refit = buildRefitLines(segments, outcome.rejected, options());
    expect(refit.map((entry) => entry.id)).toEqual([1]);
  });

  it('модель видит свою правку, свою причину и точную нехватку знаков', () => {
    const segments = [line(1, 'Короткая реплика.', 2)];
    const outcome = applyReview(segments, [{ id: 1, text_ru: tooLong, reason: 'род говорящего' }], options());
    const [entry] = buildRefitLines(segments, outcome.rejected, options());
    expect(entry!.ru).toBe('Короткая реплика.');
    expect(entry!.proposed).toBe(tooLong);
    expect(entry!.reason).toBe('род говорящего');
    expect(entry!.over).toBe(tooLong.length - entry!.max_chars);
    expect(entry!.over).toBeGreaterThan(0);
  });

  it('уложившаяся со второго раза правка принимается', () => {
    const segments = [line(1, 'Ты начал.', 2)];
    const first = applyReview(segments, [{ id: 1, text_ru: `${tooLong} начала`, reason: 'род' }], options());
    expect(first.applied).toEqual([]);

    const refit = buildRefitLines(segments, first.rejected, options());
    expect(refit).toHaveLength(1);
    // Модель переписала короче, сохранив исправление рода.
    const second = applyReview(segments, [{ id: 1, text_ru: 'Ты начала.', reason: 'род' }], options());
    expect(second.applied).toHaveLength(1);
    expect(second.segments[0]!.text_ru).toBe('Ты начала.');
  });
});

describe('цена недолёта и перелёта', () => {
  /**
   * Пока обе стороны весили одинаково, предохранитель отклонял языковые правки
   * за то, что они короче прежнего текста, а модель добивала реплики повтором
   * сказанного, чтобы пройти проверку. Слышно как раз второе.
   */
  it('языковая правка проходит, даже если оставляет паузу', () => {
    // Прежний текст в слот не влезал; правка исправляет управление глагола и
    // оказывается короче цели. Пауза дешевле ускорения — правку берём.
    const segments = [line(1, 'Юкай никогда бы не сдал меня врагам, Калия, клянусь')];
    const outcome = applyReview(segments, [{ id: 1, text_ru: 'Юкай не сдал меня' }], options());
    expect(outcome.applied).toHaveLength(1);
  });

  it('правка, укорачивающая и без того подходящую реплику, отклоняется', () => {
    // Здесь пауза берётся ниоткуда: прежний текст звучал ровно своё время.
    const segments = [line(1, 'Юкай не сдавал меня, Калия, честное слово')];
    const outcome = applyReview(segments, [{ id: 1, text_ru: 'Юкай не сдал меня' }], options());
    expect(outcome.rejected[0]?.why).toBe('worse_fit');
  });

  it('правка длиннее слота по-прежнему отклоняется', () => {
    const segments = [line(1, 'Юкай не сдавал меня')];
    const longer = 'Юкай никогда в жизни не сдавал меня никому, честное слово, поверь мне сейчас';
    const outcome = applyReview(segments, [{ id: 1, text_ru: longer }], options());
    expect(outcome.rejected[0]?.why).toBe('worse_fit');
  });
});

describe('журнал рецензии', () => {
  /**
   * Рецензия — единственная стадия, переписывающая готовый русский текст, и
   * делала она это молча. Предохранители стерегут укладку, а не смысл: выдумку,
   * влезшую в слот, видно только рядом с тем, что было.
   */
  const about = { engine: 'Kilo Gateway', model: 'anthropic/claude-sonnet-4.5', lines: 2 };

  it('хранит прежний текст, правку и пояснение', () => {
    const segments = [line(1, 'Ты начал вести себя странно')];
    const proposed = [{ id: 1, text_ru: 'Ты начала вести себя странно', reason: 'род: говорит женщина' }];
    const outcome = applyReview(segments, proposed, options());
    const journal = buildJournal(segments, proposed, outcome, options(), about);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      id: 1,
      before: 'Ты начал вести себя странно',
      after: 'Ты начала вести себя странно',
      reason: 'род: говорит женщина',
      verdict: 'applied',
    });
    expect(journal.applied).toBe(1);
    expect(journal.discarded).toBe(false);
  });

  it('отклонённая правка остаётся в журнале со своей причиной', () => {
    const segments = [line(1, 'Коротко')];
    const tooLong = 'Очень длинная фраза, которая в отведённое время никак не помещается и не поместится';
    const proposed = [{ id: 1, text_ru: tooLong }];
    const outcome = applyReview(segments, proposed, options());
    const journal = buildJournal(segments, proposed, outcome, options(), about);
    expect(journal.entries[0]?.verdict).toBe('worse_fit');
    expect(journal.entries[0]?.miss_after).toBeGreaterThan(journal.entries[0]!.miss_before);
    expect(journal.applied).toBe(0);
  });

  it('отброшенная целиком рецензия всё равно показывает, что она предлагала', () => {
    // Ради этого случая журнал и собирается по предложениям: applyReview при
    // отказе возвращает пустой список принятых, и смотреть было бы не на что.
    // Двадцать реплик — ниже этого числа доля переписанного ни о чём не говорит,
    // и предохранитель намеренно молчит.
    const segments = Array.from({ length: 24 }, (_, index) => line(index, `реплика ${index}`));
    // Правки должны укладываться не хуже прежнего текста, иначе их отклонит
    // первый предохранитель и до второго дело не дойдёт.
    const proposed = segments.map((segment) => ({ id: segment.id, text_ru: `Совсем иначе сказано в реплике ${segment.id}, да` }));
    const outcome = applyReview(segments, proposed, options());
    expect(outcome.discarded).toBe(true);
    const journal = buildJournal(segments, proposed, outcome, options(), about);
    expect(journal.discarded).toBe(true);
    expect(journal.applied).toBe(0);
    expect(journal.entries).toHaveLength(24);
    expect(journal.entries.every((entry) => entry.verdict === 'discarded')).toBe(true);
    expect(journal.entries[0]?.after).toBe('Совсем иначе сказано в реплике 0, да');
  });

  it('правка, не дожившая до решения, не выдаётся за отброшенную рецензию', () => {
    // Переспрос пересобирает набор заново: отклонённая в первом заходе правка,
    // не уложившаяся и со второй попытки, не попадает ни в принятые, ни в
    // отклонённые. На настоящем эпизоде таких оказалось четыре из тридцати трёх.
    const segments = [line(1, 'Он здесь'), line(2, 'Коротко')];
    const proposed = [
      { id: 1, text_ru: 'Клянусь, он был здесь' },
      { id: 2, text_ru: 'Совсем иначе сказано в этой реплике, да' },
    ];
    // Так делает стадия: до решения доходит только вторая правка.
    const outcome = applyReview(segments, [proposed[1]!], options());
    const journal = buildJournal(segments, proposed, outcome, options(), about);
    expect(journal.discarded).toBe(false);
    expect(journal.entries.find((entry) => entry.id === 1)?.verdict).toBe('dropped');
    expect(journal.entries.find((entry) => entry.id === 2)?.verdict).toBe('applied');
  });

  it('после переспроса записан тот текст, который приняли, а не первый', () => {
    const segments = [line(1, 'Коротко')];
    const tooLong = 'Очень длинная фраза, которая в отведённое время никак не помещается и не поместится';
    const refitted = { id: 1, text_ru: 'Ты повёл себя странно' };
    // Так делает стадия: после отказа по длине набор пересобирается заново.
    const outcome = applyReview(segments, [refitted], options());
    const journal = buildJournal(segments, [{ id: 1, text_ru: tooLong }], outcome, options(), about);
    expect(journal.entries[0]?.after).toBe('Ты повёл себя странно');
    expect(journal.entries[0]?.verdict).toBe('applied');
  });
});
