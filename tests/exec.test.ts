import { describe, it, expect } from 'vitest';
import { run, ProcessError } from '../src/util/exec.js';

/**
 * Запуск внешних процессов (SPEC §0.5).
 *
 * Команда — сам Node: он есть у любого, кто запускает тесты, и печатает ровно
 * то, что просят. Сеть, ffmpeg и ключи не нужны.
 */

const node = process.execPath;

describe('§0.5: вывод процесса не копится без просьбы', () => {
  // Дефолт был обратным, и это была ловушка: `stdout` копился всегда, а
  // `stderr` рядом обрезался до 64 КБ. Первый же забывчивый `run()` на
  // болтливом инструменте растил память прогона молча. Смена дефолта сразу
  // вскрыла четыре места, которые читали stdout, не прося его.
  it('по умолчанию stdout пуст', async () => {
    const result = await run(node, ['-e', 'process.stdout.write("x".repeat(1000))']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('с флагом stdout возвращается целиком', async () => {
    const result = await run(node, ['-e', 'process.stdout.write("привет")'], { captureStdout: true });
    expect(result.stdout).toBe('привет');
  });

  it('вывод уходит обработчику stderr, даже когда не копится', async () => {
    const seen: string[] = [];
    await run(node, ['-e', 'process.stderr.write("шаг 1\\nшаг 2\\n")'], {
      onStderr: (chunk) => seen.push(chunk),
    });
    expect(seen.join('')).toContain('шаг 1');
  });
});

describe('§0.5: ошибка процесса объяснима', () => {
  it('называет код и хвост stderr', async () => {
    try {
      await run(node, ['-e', 'console.error("модель не найдена"); process.exit(3)']);
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessError);
      expect((error as ProcessError).code).toBe(3);
      expect((error as ProcessError).stderr).toContain('модель не найдена');
      expect((error as ProcessError).message).toContain('модель не найдена');
    }
  });

  it('обрезает болтливый stderr, а не копит его', async () => {
    const result = await run(node, ['-e', 'process.stderr.write("y".repeat(200000))']);
    expect(result.code).toBe(0);
    expect(result.stderr.length).toBeLessThanOrEqual(64_000);
  });

  it('отдельно объясняет отсутствующий файл', async () => {
    try {
      await run('dubpipe-нет-такого-исполняемого', []);
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as ProcessError).message).toContain('Исполняемый файл не найден');
    }
  });
});
