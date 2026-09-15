import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { warn, warningText } from '../src/core/types.js';

/**
 * Предупреждения прогона собирались готовой русской фразой и оставались
 * русскими на английском экране — двадцать семь мест. Теперь каждое несёт ключ
 * словаря, и эта проверка держит связь: ключ без перевода снова сделал бы
 * английский интерфейс наполовину русским, а заметить это можно было бы только
 * глазами.
 */

const root = path.resolve(import.meta.dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Ключи, с которыми стадии на самом деле зовут warn(). */
function keysInCode(): Array<{ key: string; file: string }> {
  const found: Array<{ key: string; file: string }> = [];
  for (const file of sources(root)) {
    // types.ts — место, где warn() объявлена; пример в её описании вызовом не является.
    if (file.endsWith(path.join('core', 'types.ts'))) continue;
    const text = readFileSync(file, 'utf8');
    // Точка перед именем означает `log.warn` — другую функцию с тем же именем.
    for (const match of text.matchAll(/(?<![.\w])warn\(\s*'([^']+)'/g)) {
      found.push({ key: match[1]!, file: path.relative(root, file) });
    }
    // Ключ, выбранный условием: warn(flag ? 'a' : 'b', …).
    for (const match of text.matchAll(/(?<![.\w])warn\(\s*[^'\n]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
      found.push({ key: match[1]!, file: path.relative(root, file) });
      found.push({ key: match[2]!, file: path.relative(root, file) });
    }
  }
  return found;
}

/** Словарь страницы: ключ → какие языки в нём есть. */
function dictionary(): Map<string, Set<string>> {
  const text = readFileSync(path.join(root, 'ui', 'public', 'i18n.js'), 'utf8');
  const result = new Map<string, Set<string>>();
  for (const match of text.matchAll(/^\s{2}'([\w.]+)':\s*\{([\s\S]*?)\n?\s*\},?\s*$/gm)) {
    const languages = new Set<string>();
    for (const language of match[2]!.matchAll(/\b(ru|en):/g)) languages.add(language[1]!);
    result.set(match[1]!, languages);
  }
  return result;
}

describe('предупреждения прогона переводятся', () => {
  const used = keysInCode();
  const known = dictionary();

  it('стадии действительно раздают ключи, а не по одному на всех', () => {
    expect(new Set(used.map((entry) => entry.key)).size).toBeGreaterThan(20);
  });

  it('у каждого ключа есть перевод на обоих языках', () => {
    const missing = used.filter((entry) => {
      const languages = known.get(entry.key);
      return !languages || !languages.has('ru') || !languages.has('en');
    });
    expect(missing.map((entry) => `${entry.key} (${entry.file})`)).toEqual([]);
  });

  it('запасной русский текст есть всегда — ключа страница может и не знать', () => {
    const phrase = warn('warn.s7.noClips', 'Нет синтезированных реплик — итог является копией входа');
    expect(warningText(phrase)).toContain('копией входа');
    expect(warningText('просто строка')).toBe('просто строка');
  });

  it('подстановки в словаре совпадают с теми, что передаёт код', () => {
    // {count} в словаре без count в вызове оставил бы фигурные скобки на экране.
    const text = readFileSync(path.join(root, 'ui', 'public', 'i18n.js'), 'utf8');
    const entry = /'warn\.s6\.truncated':\s*\{([\s\S]*?)\},/.exec(text);
    expect(entry).not.toBeNull();
    expect(entry![1]).toContain('{count}');
  });
});

