import { describe, it, expect } from 'vitest';
import { pickSource } from '../src/stages/s7-mix.js';
import { StageError } from '../src/core/errors.js';

/**
 * Источник для сведения (SPEC FR-7).
 *
 * Регрессию нашёл прогон, а не тест: S1 перестала складывать скачанное по ссылке
 * в кэш, файл остался в рабочей папке, а `meta.input` для ссылки — это URL. S7
 * искал источник по `input` и падал, то есть дубляж по ссылке не доходил до
 * конца вообще. Здесь проверяется выбор без ffmpeg и без файловой системы.
 */

/** Заглушка «файл существует»: набор путей, которые тест считает настоящими. */
const existing = (...paths: string[]) => {
  const set = new Set(paths);
  return (filePath: string) => set.has(filePath);
};

describe('§FR-7: откуда S7 берёт источник', () => {
  it('для ссылки — путь, записанный S1: input там URL', () => {
    const downloaded = 'C:\\videos\\Ролик [dQw4w9WgXcQ].mp4';
    const source = pickSource(
      { input: 'https://youtu.be/dQw4w9WgXcQ', source_path: downloaded },
      (extension) => `C:\\cache\\source.${extension}`,
      existing(downloaded),
    );
    expect(source).toBe(downloaded);
  });

  it('находит источник в старом рабочем каталоге', () => {
    // До этой правки скачанное лежало в кэше под именем source.mp4, и такие
    // рабочие каталоги ещё живут на дисках.
    const cached = 'C:\\cache\\source.mp4';
    const source = pickSource(
      { input: 'https://youtu.be/dQw4w9WgXcQ' },
      (extension) => `C:\\cache\\source.${extension}`,
      existing(cached),
    );
    expect(source).toBe(cached);
  });

  it('для локального файла берёт сам вход', () => {
    const file = 'C:\\videos\\lecture.mp4';
    const source = pickSource({ input: file }, (extension) => `C:\\cache\\source.${extension}`, existing(file));
    expect(source).toBe(file);
  });

  it('приоритет у записанного пути, даже если в кэше что-то осталось', () => {
    const downloaded = 'C:\\videos\\новое.mp4';
    const stale = 'C:\\cache\\source.mp4';
    const source = pickSource(
      { input: 'https://youtu.be/x', source_path: downloaded },
      (extension) => `C:\\cache\\source.${extension}`,
      existing(downloaded, stale),
    );
    expect(source).toBe(downloaded);
  });

  it('если скачанное удалили, ошибка называет путь, где его искали', () => {
    const downloaded = 'C:\\videos\\Ролик [id].mp4';
    expect(() =>
      pickSource(
        { input: 'https://youtu.be/id', source_path: downloaded },
        (extension) => `C:\\cache\\source.${extension}`,
        existing(),
      ),
    ).toThrow(StageError);

    try {
      pickSource(
        { input: 'https://youtu.be/id', source_path: downloaded },
        (extension) => `C:\\cache\\source.${extension}`,
        existing(),
      );
    } catch (error) {
      expect((error as StageError).message).toContain('не найден исходный файл');
      expect((error as StageError).hints.join(' ')).toContain(downloaded);
    }
  });

  it('для ссылки без записанного пути подсказывает перезапуск S1', () => {
    try {
      pickSource({ input: 'https://youtu.be/id' }, (extension) => `C:\\cache\\source.${extension}`, existing());
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as StageError).hints.join(' ')).toContain('--from-stage s1');
    }
  });
});
