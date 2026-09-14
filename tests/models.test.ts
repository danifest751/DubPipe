import { describe, it, expect } from 'vitest';
import { estimateCost, filterCatalog, formatCost, parseCatalog } from '../src/providers/llm/catalog.js';
import { formatSideBySide, formatSummary, type ComparisonReport } from '../src/core/compare.js';

const rawCatalog = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Anthropic: Claude Sonnet 4.5',
      context_length: 1_000_000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      architecture: { output_modalities: ['text'] },
    },
    {
      id: 'vendor/free-model:free',
      name: 'Vendor: Free Model',
      context_length: 256_000,
      pricing: { prompt: '0', completion: '0' },
      architecture: { output_modalities: ['text'] },
    },
    {
      id: 'google/lyria-3-pro-preview',
      name: 'Google: Lyria 3 (музыка)',
      context_length: 1_000_000,
      pricing: { prompt: '0', completion: '0' },
      architecture: { output_modalities: ['text', 'audio'] },
    },
    {
      id: 'legacy/no-architecture',
      name: 'Legacy model',
      pricing: { prompt: '0.000001', completion: '0.000002' },
    },
  ],
};

describe('Каталог моделей шлюза', () => {
  it('разбирает цены и признак бесплатности', () => {
    const catalog = parseCatalog(rawCatalog);
    const sonnet = catalog.find((model) => model.id === 'anthropic/claude-sonnet-4.5')!;
    expect(sonnet.promptPrice).toBeCloseTo(0.000003, 9);
    expect(sonnet.completionPrice).toBeCloseTo(0.000015, 9);
    expect(sonnet.free).toBe(false);
    expect(catalog.find((model) => model.id === 'vendor/free-model:free')!.free).toBe(true);
  });

  it('исключает модели, отдающие не только текст', () => {
    // Lyria генерирует музыку и переводчиком быть не может, хотя формально
    // перечисляет text среди выходов.
    const ids = parseCatalog(rawCatalog).map((model) => model.id);
    expect(ids).not.toContain('google/lyria-3-pro-preview');
  });

  it('оставляет записи без описания модальностей', () => {
    const ids = parseCatalog(rawCatalog).map((model) => model.id);
    expect(ids).toContain('legacy/no-architecture');
  });

  it('переживает пустой и неожиданный ответ', () => {
    expect(parseCatalog({ data: [] })).toEqual([]);
    expect(parseCatalog([])).toEqual([]);
    expect(parseCatalog({ data: [{ name: 'без id' }] })).toEqual([]);
  });

  it('фильтрует по подстроке и по бесплатности', () => {
    const catalog = parseCatalog(rawCatalog);
    expect(filterCatalog(catalog, { search: 'sonnet' }).map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4.5',
    ]);
    expect(filterCatalog(catalog, { search: 'CLAUDE' })).toHaveLength(1);
    expect(filterCatalog(catalog, { freeOnly: true }).map((m) => m.id)).toEqual(['vendor/free-model:free']);
    expect(filterCatalog(catalog, { limit: 2 })).toHaveLength(2);
  });
});

describe('Стоимость прогона', () => {
  it('берёт стоимость, сообщённую провайдером', () => {
    const cost = estimateCost(undefined, { promptTokens: 1000, completionTokens: 500, cost: 0.0042 });
    expect(cost).toBe(0.0042);
  });

  it('считает по прайсу каталога, если провайдер её не вернул', () => {
    const [sonnet] = parseCatalog(rawCatalog);
    const cost = estimateCost(sonnet, { promptTokens: 1000, completionTokens: 1000 });
    expect(cost).toBeCloseTo(0.000003 * 1000 + 0.000015 * 1000, 9);
  });

  it('без каталога и без ответа провайдера возвращает ноль', () => {
    expect(estimateCost(undefined, { promptTokens: 100, completionTokens: 100 })).toBe(0);
  });

  it('форматирует стоимость по величине', () => {
    expect(formatCost(0)).toBe('бесплатно');
    // Мелкие суммы — с пятью знаками, крупные — с четырьмя.
    expect(formatCost(0.00008)).toBe('$0.00008');
    expect(formatCost(0.0042)).toBe('$0.00420');
    expect(formatCost(1.5)).toBe('$1.5000');
  });
});

const report = (): ComparisonReport => ({
  input: 'sample.mp4',
  createdAt: '2026-09-13T00:00:00.000Z',
  replicaCount: 2,
  models: [
    {
      model: 'slow/model',
      ok: false,
      error: 'превышен лимит времени 60 с',
      stats: { total: 0, withinTolerance: 0, share: 0, tooLong: 0, tooShort: 0, passed: false },
      usage: { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 },
      costUsd: 0,
      elapsedMs: 0,
      glossary: {},
      lines: [],
    },
    {
      model: 'good/model',
      ok: true,
      stats: { total: 2, withinTolerance: 2, share: 1, tooLong: 0, tooShort: 0, passed: true },
      usage: { promptTokens: 100, completionTokens: 50, cost: 0.001, requests: 1 },
      costUsd: 0.001,
      elapsedMs: 4200,
      glossary: {},
      lines: [
        { id: 0, slot: 2, text_en: 'Hello', text_ru: 'Привет', fits: true },
        { id: 1, slot: 1, text_en: 'Bye', text_ru: 'Пока', fits: false },
      ],
    },
  ],
});

describe('Отчёт сравнения моделей', () => {
  it('ставит успешные модели выше упавших', () => {
    const summary = formatSummary(report());
    const lines = summary.split('\n');
    expect(lines[2]).toContain('good/model');
    expect(lines[3]).toContain('slow/model');
  });

  it('показывает причину отказа вместо цифр', () => {
    expect(formatSummary(report())).toContain('превышен лимит времени 60 с');
  });

  it('в сводке есть доля попаданий, время и стоимость', () => {
    const summary = formatSummary(report());
    expect(summary).toContain('2/2 (100%)');
    expect(summary).toContain('4.2 с');
    expect(summary).toContain('$0.00100');
  });

  it('построчное сравнение помечает укладку в отведённое место', () => {
    const side = formatSideBySide(report());
    // Место, а не слот: перевод заказан по слоту вместе с занимаемой паузой,
    // и судить строку надо по нему же.
    expect(side).toContain('[0] место 2.00 с — Hello');
    expect(side).toContain('✓ good/model');
    expect(side).toContain('✗ good/model');
  });

  it('сообщает, если ни одна модель не сработала', () => {
    const failed = report();
    failed.models = [failed.models[0]!];
    expect(formatSideBySide(failed)).toContain('Ни одна модель не выдала перевод');
  });
});
