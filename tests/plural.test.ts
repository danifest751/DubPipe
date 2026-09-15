import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Склонение по числу на странице.
 *
 * «4 реплик» стояло в панели героев и в списке смены говорящего — там, где эту
 * строку читают чаще всего. Словарь подключается к странице обычным тегом, без
 * экспорта, поэтому здесь он исполняется в песочнице с заглушками браузера.
 */
function load(language: string): (key: string, values?: Record<string, unknown>) => string {
  const source = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'ui', 'public', 'i18n.js'), 'utf8');
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    navigator: { language },
    localStorage: { getItem: () => null, setItem: () => undefined },
    document: { querySelectorAll: () => [], documentElement: { lang: language } },
  };
  vm.runInNewContext(source, sandbox);
  return (sandbox['window'] as { t: (key: string, values?: Record<string, unknown>) => string }).t;
}

describe('склонение по числу', () => {
  const t = load('ru');

  it('русские формы выбираются по последним цифрам', () => {
    expect(t('cast.replicas', { count: 1 })).toBe('1 реплика');
    expect(t('cast.replicas', { count: 4 })).toBe('4 реплики');
    expect(t('cast.replicas', { count: 5 })).toBe('5 реплик');
    expect(t('cast.replicas', { count: 21 })).toBe('21 реплика');
    expect(t('cast.replicas', { count: 22 })).toBe('22 реплики');
    // Одиннадцать-четырнадцать — исключение: «11 реплик», а не «11 реплика».
    expect(t('cast.replicas', { count: 11 })).toBe('11 реплик');
    expect(t('cast.replicas', { count: 14 })).toBe('14 реплик');
    expect(t('cast.replicas', { count: 0 })).toBe('0 реплик');
  });

  it('английские формы — две', () => {
    const en = load('en');
    expect(en('cast.replicas', { count: 1 })).toBe('1 replica');
    expect(en('cast.replicas', { count: 4 })).toBe('4 replicas');
  });

  it('строки без вариантов не трогаются', () => {
    expect(t('segments.count', { count: 3 })).toBe('3 реплики');
    expect(t('cast.title')).toBe('Голоса и персонажи');
  });
});
