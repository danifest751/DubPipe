import { describe, it, expect } from 'vitest';
import { CHECK_SAMPLE, judgeTranslation, tidyReason, type ModelCheckLine } from '../src/core/model-check.js';

const line = (text_en: string, text_ru: string | null, fits = true): ModelCheckLine => ({ text_en, text_ru, fits });

describe('§16.4: проверка модели перевода', () => {
  it('пробный набор — три короткие реплики со слотами', () => {
    expect(CHECK_SAMPLE).toHaveLength(3);
    for (const item of CHECK_SAMPLE) expect(item.end).toBeGreaterThan(item.start);
  });

  it('принимает русский перевод всех реплик', () => {
    expect(judgeTranslation([line('Hi.', 'Привет.'), line('Go.', 'Иди.')])).toEqual({ ok: true, reason: null });
  });

  it('отвергает пустой ответ и пропуски', () => {
    expect(judgeTranslation([]).reason).toMatch(/ни одной/);
    expect(judgeTranslation([line('Hi.', 'Привет.'), line('Go.', null)]).reason).toBe('переведено 1 из 2 реплик');
  });

  it('сводит ответ шлюза к одной строке', () => {
    const raw = '[s3] пакет 1/1: Шлюз ответил 404: {"error":"The requested model \'x/y\' does not exist. Please use an exact model id.","error_type":"model_not_found"}';
    expect(tidyReason(raw)).toBe("шлюз ответил 404: The requested model 'x/y' does not exist. Please use an exact model id.");
    expect(tidyReason('[s3] пакет 1/1: Шлюз ответил 500: {"error":{"message":"overloaded"}}')).toBe('шлюз ответил 500: overloaded');
    expect(tidyReason('нет ответа за 60 с')).toBe('нет ответа за 60 с');
    expect(tidyReason('Шлюз ответил 502: {"error":"' + 'x'.repeat(300)).length).toBeLessThanOrEqual(160);
  });

  it('отвергает ответ не по-русски, в том числе эхо оригинала', () => {
    expect(judgeTranslation([line('Hi.', 'Hello there.')]).reason).toMatch(/не по-русски/);
    expect(judgeTranslation([line('Hi.', 'Hi.')]).ok).toBe(false);
  });
});
