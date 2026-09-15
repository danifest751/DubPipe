import { describe, it, expect } from 'vitest';
import { markLines } from '../src/core/compare.js';
import {
  buildBatchRequest,
  collectMisfits,
  markUntranslated,
  estimateSpeechSeconds,
  extractJson,
  formatContext,
  formatGlossary,
  lengthStats,
  lengthVerdict,
  parseTranslationResponse,
  planBatches,
  profanityRule,
  lengthRule,
  renderSystemPrompt,
  roomFor,
  targetChars,
} from '../src/stages/s3-translate.js';
import { makeSegment, warningText, type Segment, type StageWarning } from '../src/core/types.js';
import { parseConfig } from '../src/config/load.js';

const seg = (id: number, start: number, end: number, en: string, ru: string | null = null): Segment =>
  makeSegment({ id, start, end, text_en: en, text_ru: ru });

describe('FR-3: оценка длительности и допуск', () => {
  it('оценивает длительность по символам в секунду', () => {
    expect(estimateSpeechSeconds('абвгдеёжзи', 10)).toBeCloseTo(1, 5);
    expect(estimateSpeechSeconds('  два   слова  ', 5)).toBeCloseTo('два слова'.length / 5, 5);
  });

  it('считает попадание в допуск ±15%', () => {
    const verdict = lengthVerdict('а'.repeat(29), 2, 14.5, 0.15);
    expect(verdict.ratio).toBeCloseTo(1, 2);
    expect(verdict.withinTolerance).toBe(true);
  });

  it('ловит слишком длинную реплику', () => {
    const verdict = lengthVerdict('а'.repeat(60), 2, 14.5, 0.15);
    expect(verdict.ratio).toBeGreaterThan(1.15);
    expect(verdict.withinTolerance).toBe(false);
  });

  it('абсолютный порог спасает короткие слоты', () => {
    // Слот 0.66 с: ±15% — это ±1,4 символа, недостижимо ни на каком языке.
    const strict = lengthVerdict('Справедливо.', 0.66, 14.5, 0.15, 0);
    const withFloor = lengthVerdict('Справедливо.', 0.66, 14.5, 0.15, 0.25);
    expect(strict.withinTolerance).toBe(false);
    expect(withFloor.withinTolerance).toBe(true);
  });

  it('порог не оправдывает явный промах', () => {
    const verdict = lengthVerdict('а'.repeat(60), 0.66, 14.5, 0.15, 0.25);
    expect(verdict.withinTolerance).toBe(false);
  });

  it('вычитает из слота постоянную надбавку на реплику', () => {
    // Слот 2 с при надбавке 0.5 с оставляет на речь полторы секунды.
    expect(targetChars(2, 17.8, 0, 0.5)).toBe(27);
    // Без надбавки — как было: всё время идёт под знаки.
    expect(targetChars(2, 17.8)).toBe(36);
    // Реплика короче надбавки: просить хотя бы один знак.
    expect(targetChars(0.3, 17.8, 0, 0.5)).toBe(1);
  });

  it('считает целевое число символов из слота', () => {
    expect(targetChars(2, 14.5)).toBe(29);
    expect(targetChars(0, 14.5)).toBe(1);
  });
});

describe('FR-3: оценка длительности учитывает надбавку', () => {
  // Целевая длина и проверка «влезает ли» обязаны считать по одной модели.
  // Когда они расходились, отчёт объявлял недобором 33 нормальные реплики.
  it('оценка включает постоянную надбавку на реплику', () => {
    expect(estimateSpeechSeconds('а'.repeat(20), 20, 0.5)).toBeCloseTo(1.5, 5);
    expect(estimateSpeechSeconds('а'.repeat(20), 20)).toBeCloseTo(1, 5);
  });

  it('вердикт по той же модели, что и цель', () => {
    // 27 знаков при темпе 17.8 и надбавке 0.51 — это ровно два секунды слота.
    const text = 'а'.repeat(targetChars(2, 17.8, 0, 0.51));
    const verdict = lengthVerdict(text, 2, 17.8, 0.15, 0, 0.51);
    expect(verdict.withinTolerance).toBe(true);
    // Та же реплика без учёта надбавки выглядит недобором.
    expect(lengthVerdict(text, 2, 17.8, 0.15, 0).ratio).toBeLessThan(0.85);
  });
});

describe('M2: сводка по длине', () => {
  it('требует не менее 90% реплик в допуске', () => {
    const good = Array.from({ length: 10 }, (_, i) => seg(i, 0, 2, 'x', 'а'.repeat(29)));
    expect(lengthStats(good, 14.5, 0.15).passed).toBe(true);

    good[0]!.text_ru = 'а'.repeat(120);
    good[1]!.text_ru = 'а'.repeat(120);
    const stats = lengthStats(good, 14.5, 0.15);
    expect(stats.withinTolerance).toBe(8);
    expect(stats.tooLong).toBe(2);
    expect(stats.passed).toBe(false);
  });

  it('не учитывает непереведённые реплики', () => {
    const stats = lengthStats([seg(0, 0, 2, 'x'), seg(1, 0, 2, 'y', 'а'.repeat(29))], 14.5, 0.15);
    expect(stats.total).toBe(1);
  });

  it('пустой список не делит на ноль', () => {
    const stats = lengthStats([], 14.5, 0.15);
    expect(stats.share).toBe(0);
    expect(stats.total).toBe(0);
  });
});

describe('§3.4: разбиение на пакеты', () => {
  it('режет по размеру пакета', () => {
    const segments = Array.from({ length: 25 }, (_, i) => seg(i, i, i + 0.5, 'x'));
    const batches = planBatches(segments, 10);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
  });

  it('режет на смене сцены по длинной паузе', () => {
    const segments = [seg(0, 0, 1, 'a'), seg(1, 1.2, 2, 'b'), seg(2, 20, 21, 'c')];
    const batches = planBatches(segments, 10, 3);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.map((s) => s.id)).toEqual([0, 1]);
    expect(batches[1]!.map((s) => s.id)).toEqual([2]);
  });

  it('пустой вход даёт пустой список пакетов', () => {
    expect(planBatches([], 10)).toEqual([]);
  });

  it('в запрос попадают id, слот и целевая длина', () => {
    // Оригинал достаточно длинный, чтобы цель задавал слот, а не ограничение
    // «не более чем вдвое длиннее оригинала».
    const request = buildBatchRequest([seg(7, 1, 3, 'Hello there, how are you doing today?')], 14.5);
    expect(request).toContain('"id":7');
    expect(request).toContain('"slot_seconds":2');
    expect(request).toContain('"target_chars":29');
    expect(request).toContain('Hello there');
  });

  it('цель по длине не превышает оригинал более чем вдвое', () => {
    // Одно слово в двухсекундном слоте: по слоту вышло бы 29 символов.
    const request = buildBatchRequest([seg(7, 1, 3, 'Hello')], 14.5);
    expect(request).toContain('"target_chars":10');
  });

  it('без добивания до цели то же число уходит как предел, а не как цель', () => {
    // Имя поля и есть правило: «цель» модель добивает («Лиза.» → «Лиза, Лиза»),
    // «предел» — нет. Число одно и то же, поведение разное.
    const request = buildBatchRequest([seg(7, 1, 3, 'Hello there, how are you doing today?')], 14.5, undefined, 0, undefined, false);
    expect(request).toContain('"max_chars":29');
    expect(request).not.toContain('target_chars');
  });
});

describe('правило длины в промпте зависит от настройки', () => {
  it('с добиванием говорит о цели и об отклонении в обе стороны', () => {
    const rule = lengthRule(true);
    expect(rule).toContain('target_chars');
    expect(rule).toContain('в любую сторону');
  });

  it('без добивания нижней границы нет вовсе', () => {
    const rule = lengthRule(false);
    expect(rule).toContain('max_chars');
    expect(rule).toContain('Нижней границы нет');
    expect(rule).not.toContain('target_chars');
  });

  it('промпт подставляет то правило, которое выбрано', () => {
    const rendered = renderSystemPrompt('L:{length_rule}|P:{profanity_rule}', {
      glossary: '',
      context: '',
      profanityRule: 'x',
      lengthRule: lengthRule(false),
    });
    expect(rendered).toContain('Нижней границы нет');
  });
});

describe('§3.4: разбор ответа модели', () => {
  it('сопоставляет реплики по id, а не по позиции', () => {
    const raw = '{"items":[{"id":2,"text_ru":"второй"},{"id":1,"text_ru":"первый"}]}';
    const payload = parseTranslationResponse(raw, [1, 2]);
    expect(payload.items.get(1)).toBe('первый');
    expect(payload.items.get(2)).toBe('второй');
  });

  it('игнорирует чужие id', () => {
    const payload = parseTranslationResponse('{"items":[{"id":99,"text_ru":"чужой"}]}', [1]);
    expect(payload.items.size).toBe(0);
  });

  it('переживает markdown-обёртку вокруг JSON', () => {
    const raw = 'Вот перевод:\n```json\n{"items":[{"id":1,"text_ru":"ок"}]}\n```\nГотово.';
    expect(parseTranslationResponse(raw, [1]).items.get(1)).toBe('ок');
  });

  it('принимает голый массив вместо объекта', () => {
    expect(parseTranslationResponse('[{"id":1,"text_ru":"ок"}]', [1]).items.get(1)).toBe('ок');
  });

  it('не спотыкается о скобки внутри строк', () => {
    const raw = '{"items":[{"id":1,"text_ru":"скобка } внутри"}]}';
    expect(parseTranslationResponse(raw, [1]).items.get(1)).toBe('скобка } внутри');
  });

  it('собирает глоссарий из ответа', () => {
    const raw = '{"items":[{"id":1,"text_ru":"ок"}],"glossary":{"Acme":"Акме","":"пусто"}}';
    const payload = parseTranslationResponse(raw, [1]);
    expect(payload.glossary).toEqual({ Acme: 'Акме' });
  });

  it('отвергает ответ без JSON', () => {
    expect(() => parseTranslationResponse('не могу перевести', [1])).toThrow(/нет JSON/);
  });

  it('отвергает JSON без массива items', () => {
    expect(() => parseTranslationResponse('{"result":"ok"}', [1])).toThrow(/items/);
  });

  it('пропускает элементы без текста', () => {
    const payload = parseTranslationResponse('{"items":[{"id":1,"text_ru":"  "},{"id":2,"text_ru":"ок"}]}', [1, 2]);
    expect(payload.items.has(1)).toBe(false);
    expect(payload.items.get(2)).toBe('ок');
  });

  it('извлекает первый сбалансированный объект', () => {
    expect(extractJson('шум {"a":{"b":1}} хвост')).toBe('{"a":{"b":1}}');
    expect(extractJson('без json')).toBeNull();
  });
});

describe('FR-3: корректирующий проход', () => {
  it('отбирает реплики вне допуска и направление правки', () => {
    const segments = [
      seg(0, 0, 2, 'ok', 'а'.repeat(29)),
      seg(1, 3, 5, 'a reply that is long enough', 'а'.repeat(80)),
      seg(2, 6, 8, 'short', 'ах'),
    ];
    const misfits = collectMisfits(segments, 14.5, 0.15, 0.25);
    expect(misfits.map((m) => m.segment.id)).toEqual([1, 2]);
    expect(misfits[0]!.action).toBe('shorten');
    expect(misfits[1]!.action).toBe('expand');
    expect(misfits[0]!.targetChars).toBe(29);
  });

  it('не трогает непереведённые реплики', () => {
    expect(collectMisfits([seg(0, 0, 2, 'x')], 14.5, 0.15, 0.25)).toEqual([]);
  });
});

describe('Промпт перевода', () => {
  it('подставляет глоссарий, контекст и правило лексики', () => {
    const rendered = renderSystemPrompt('G:{glossary}|C:{context}|P:{profanity_rule}', {
      glossary: '- Acme → Акме',
      context: '- hi → привет',
      profanityRule: 'смягчай',
    });
    expect(rendered).toBe('G:- Acme → Акме|C:- hi → привет|P:смягчай');
  });

  it('подставляет заглушки вместо пустых значений', () => {
    const rendered = renderSystemPrompt('G:{glossary}|C:{context}|P:{profanity_rule}', {
      glossary: '',
      context: '',
      profanityRule: 'x',
    });
    expect(rendered).toContain('(пока пуст)');
    expect(rendered).toContain('(начало ролика)');
  });

  it('формирует глоссарий и контекст', () => {
    expect(formatGlossary({ Acme: 'Акме', Bob: 'Боб' })).toBe('- Acme → Акме\n- Bob → Боб');
    expect(formatGlossary({})).toBe('');
    expect(formatContext([seg(0, 0, 1, 'hi', 'привет')])).toBe('- hi → привет');
    expect(formatContext([])).toBe('');
  });

  it('различает режимы обработки мата', () => {
    expect(profanityRule('keep')).toContain('как есть');
    expect(profanityRule('hard')).toContain('***');
    expect(profanityRule('soft')).toContain('смягчай');
  });
});

describe('FR-3: реплика осталась без перевода', () => {
  it('латиницу оставляем как есть: русский голос её прочитает', () => {
    const segment = makeSegment({ id: 3, start: 0, end: 2, text_en: 'Fair enough.' });
    const warnings: StageWarning[] = [];
    markUntranslated(segment, warnings);
    expect(segment.text_ru).toBe('Fair enough.');
    expect(segment.flags).toContain('translation_failed');
    expect(warningText(warnings[0]!)).toContain('оставлен оригинал');
  });

  it('хангыль и иероглифы не подставляем: синтезатор сделает из них мусор', () => {
    const warnings: StageWarning[] = [];
    const korean = makeSegment({ id: 4, start: 0, end: 2, text_en: '고마워요. 회의실은 어디예요?' });
    markUntranslated(korean, warnings);
    expect(korean.text_ru).toBeNull();
    expect(korean.flags).toContain('translation_failed');
    expect(warningText(warnings[0]!)).toContain('без озвучки');

    const chinese = makeSegment({ id: 5, start: 0, end: 2, text_en: '你好吗？' });
    markUntranslated(chinese, warnings);
    expect(chinese.text_ru).toBeNull();
  });

  it('флаг не задваивается при повторной пометке', () => {
    const segment = makeSegment({ id: 6, start: 0, end: 2, text_en: 'Hello.' });
    const warnings: string[] = [];
    markUntranslated(segment, warnings);
    markUntranslated(segment, warnings);
    expect(segment.flags.filter((flag) => flag === 'translation_failed')).toHaveLength(1);
  });
});

describe('Сравнение моделей: сводка и строки судят одинаково', () => {
  const config = () =>
    parseConfig({ alignment: { borrow_silence_ms: 1200, gap_ms: 50 } }, 'test');

  const line = (id: number, start: number, end: number, chars: number) =>
    makeSegment({ id, start, end, text_en: `line ${id}`, text_ru: 'а'.repeat(chars) });

  it('крестиков в строках ровно столько, сколько недобора в сводке', () => {
    // Своя мерка в построчной пометке делала отчёт противоречивым: сводка
    // сообщала долю в допуске, а строки под ней были помечены иначе.
    const settings = config();
    const segments = [line(0, 0, 2, 12), line(1, 10, 12, 60), line(2, 20, 23, 40), line(3, 30, 30.8, 4)];
    const { chars_per_second: cps, length_tolerance: tolerance, speech_overhead_seconds: overhead } = settings.translate;
    const floor = settings.translate.length_tolerance_floor_ms / 1000;

    const marks = markLines(segments, settings);
    const stats = lengthStats(segments, cps, tolerance, floor, overhead, roomFor(settings, segments));

    expect(marks.filter((mark) => mark.fits)).toHaveLength(stats.withinTolerance);
  });

  it('в отчёт идёт место реплики, а не голый слот', () => {
    const settings = config();
    const segments = [line(0, 0, 2, 12), line(1, 10, 12, 12)];
    // После первой реплики пауза, занять из неё разрешено 1.2 с.
    expect(markLines(segments, settings)[0]!.slot).toBeCloseTo(3.2, 2);
  });

  it('непереведённая реплика не считается уложившейся', () => {
    const settings = config();
    const segments = [makeSegment({ id: 0, start: 0, end: 2, text_en: 'line' })];
    expect(markLines(segments, settings)[0]!.fits).toBe(false);
  });
});
