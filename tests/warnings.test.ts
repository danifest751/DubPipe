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

/**
 * Предупреждение, положенное в массив строкой, а не через `warn()`.
 *
 * Такое не переведётся: страница знает только ключ. Проверка `keysInCode()`
 * их не видит по построению — она ищет вызовы `warn()`, — и два предупреждения
 * S2 («речь не обнаружена», «пол не определён») месяцами оставались русскими
 * на английском экране, пока тест печатал «пройдено». Ключи для обоих лежали
 * в словаре и никем не вызывались.
 */
function rawWarningsInCode(): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    // Литерал сразу после `warnings.push(` — значит warn() не позван.
    for (const match of text.matchAll(/warnings\.push\(\s*([`'"])([\s\S]*?)\1/g)) {
      const literal = match[2]!;
      if (!/[а-яА-ЯёЁ]/.test(literal)) continue;
      found.push({ file: path.relative(root, file), text: literal.slice(0, 60) });
    }
  }
  return found;
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

  it('каждое предупреждение собирается через warn(), а не строкой', () => {
    expect(rawWarningsInCode()).toEqual([]);
  });

  it('в словаре нет ключей предупреждений, которых никто не зовёт', () => {
    // Сирота — это ключ, для которого текст написан, а код о нём не знает:
    // ровно так разошлись `warn.s2.noSpeech` и `warn.s2.gender`.
    const usedKeys = new Set(used.map((entry) => entry.key));
    const orphans = [...known.keys()].filter((key) => key.startsWith('warn.') && !usedKeys.has(key));
    expect(orphans).toEqual([]);
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

describe('флаги реплик переводятся', () => {
  /**
   * Столбец «Флаги» показывал ключи как есть, и человек читал `force_split`
   * посреди русского экрана. Проверка держит связь: новый флаг в types.ts без
   * строки в словаре снова вернул бы туда внутреннее имя.
   */
  it('у каждого флага из types.ts есть строка на обоих языках', () => {
    const types = readFileSync(path.join(root, 'core', 'types.ts'), 'utf8');
    const union = /export type SegmentFlag =([\s\S]*?);/.exec(types);
    expect(union).not.toBeNull();
    const flags = [...union![1]!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
    expect(flags.length).toBeGreaterThan(4);
    const known = dictionary();
    const missing = flags.filter((flag) => {
      const languages = known.get(`segments.flag.${flag}`);
      return !languages || !languages.has('ru') || !languages.has('en');
    });
    expect(missing).toEqual([]);
  });
});
