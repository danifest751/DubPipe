import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Заглушки подписей в разметке и словарь — два ответа на один вопрос.
 *
 * Пока скрипт не выполнился, страница показывает текст из `data-i18n`, и он
 * должен быть тем же, что в словаре. Иначе получается то же расхождение, что
 * было с числом голосов silero: словарь говорил «34» после правки, а разметка
 * продолжала обещать «29». Заметить это можно было только глазами — сверки не
 * существовало.
 *
 * Проверяются только заглушки, лежащие в разметке одной строкой и без
 * вложенных тегов: их видно и без запуска страницы. Подписи, собираемые в
 * `app.js`, проверяет `warnings.test.ts` со стороны ключей.
 */

const uiDir = path.resolve(import.meta.dirname, '..', 'src', 'ui', 'public');

/**
 * Русские строки словаря.
 *
 * Файл — не модуль (он вешается на `window`), поэтому читается текстом.
 * Значение может стоять как в одну строку с ключом, так и ниже, поэтому тело
 * объекта добирается до закрывающей скобки.
 */
function dictionaryRu(): Map<string, string> {
  const lines = readFileSync(path.join(uiDir, 'i18n.js'), 'utf8').split(/\r?\n/);
  const result = new Map<string, string>();

  for (let index = 0; index < lines.length; index++) {
    const header = /^ {2}'([\w.]+)':\s*\{(.*)$/.exec(lines[index]!);
    if (!header) continue;

    let body = header[2]!;
    for (let next = index + 1; !body.includes('}') && next < lines.length; next++) {
      body += `\n${lines[next]!}`;
    }

    const ru = /ru:\s*'((?:[^'\\]|\\.)*)'/.exec(body);
    if (ru) result.set(header[1]!, ru[1]!.replace(/\\'/g, "'"));
  }
  return result;
}

/** Заглушки из разметки: ключ, видимый до перевода текст и номер строки. */
function fallbacks(): Array<{ key: string; text: string; line: number }> {
  const lines = readFileSync(path.join(uiDir, 'index.html'), 'utf8').split(/\r?\n/);
  const result: Array<{ key: string; text: string; line: number }> = [];
  lines.forEach((line, index) => {
    const match = /data-i18n="([^"]+)"[^>]*>([^<]*)</.exec(line);
    if (!match) return;
    const text = match[2]!.trim();
    if (text) result.push({ key: match[1]!, text, line: index + 1 });
  });
  return result;
}

describe('подписи в разметке не расходятся со словарём', () => {
  const dictionary = dictionaryRu();
  const placeholders = fallbacks();

  it('заглушек вообще есть — иначе проверка ничего не проверяет', () => {
    expect(placeholders.length).toBeGreaterThan(150);
  });

  it('у каждой заглушки есть русский текст в словаре', () => {
    const unknown = placeholders.filter((item) => !dictionary.has(item.key));
    expect(unknown.map((item) => `${item.key} (index.html:${item.line})`)).toEqual([]);
  });

  it('текст заглушки совпадает с русским текстом словаря', () => {
    const drifted = placeholders
      .filter((item) => dictionary.has(item.key) && dictionary.get(item.key) !== item.text)
      .map(
        (item) =>
          `${item.key} (index.html:${item.line})\n` +
          `  разметка: ${item.text}\n` +
          `  словарь:  ${dictionary.get(item.key)}`,
      );
    expect(drifted).toEqual([]);
  });
});
