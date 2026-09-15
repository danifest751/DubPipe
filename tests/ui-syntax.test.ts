import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Код страницы разбирается без ошибок.
 *
 * Линтер сюда не заглядывает: `src/ui/public` исключён из его правил, потому
 * что это браузерный код с другими глобальными именами. Из-за этого правка с
 * лишней скобкой прошла все проверки, попала в сборку — и приложение открылось
 * пустым окном, где ничего не нажимается: браузер не разобрал скрипт целиком.
 *
 * Проверка грубая намеренно: она не про стиль, а про то, что файл вообще
 * является программой. Такое стоит ловить до сборки, а не глазами пользователя.
 */

const dir = path.resolve(import.meta.dirname, '..', 'src', 'ui', 'public');

describe('скрипты страницы разбираются', () => {
  const scripts = readdirSync(dir).filter((name) => name.endsWith('.js'));

  it('в каталоге есть что проверять', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  for (const name of scripts) {
    it(`${name} — синтаксис в порядке`, () => {
      expect(() => execFileSync(process.execPath, ['--check', path.join(dir, name)], { stdio: 'pipe' })).not.toThrow();
    });
  }
});
