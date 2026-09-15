import { describe, it, expect } from 'vitest';
import { makeSegment, type Segment } from '../src/core/types.js';
import {
  applyReview,
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
  const all = { gender: true, glossary: true, address: true, consistency: true, meaning: true, length: true };

  it('перечисляет только включённое', () => {
    const only = checksSection({ ...all, gender: false, address: false, consistency: false, meaning: false });
    expect(only).toContain('Имена и термины');
    expect(only).toContain('Длина');
    expect(only).not.toContain('Род.');
    expect(only).not.toContain('Ты и вы');
  });

  it('при всех выключенных честно говорит, что проверять нечего', () => {
    const none = checksSection({ gender: false, glossary: false, address: false, consistency: false, meaning: false, length: false });
    expect(none).toContain('все проверки отключены');
  });
});
