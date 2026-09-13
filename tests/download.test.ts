import { describe, it, expect } from 'vitest';
import { planChunks } from '../src/util/download.js';
import { TOOLS, type ToolName } from '../src/util/tools.js';

/**
 * Разбиение файла на части для многопоточной загрузки.
 * Сеть не нужна: проверяется чистая функция.
 */

describe('Многопоточная загрузка: разбиение на диапазоны', () => {
  it('покрывает файл целиком без разрывов и нахлёстов', () => {
    const size = 106_000_123;
    const chunks = planChunks(size, 4);

    expect(chunks).toHaveLength(4);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(size - 1);

    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index]!.start).toBe(chunks[index - 1]!.end + 1);
    }

    const covered = chunks.reduce((sum, chunk) => sum + (chunk.end - chunk.start + 1), 0);
    expect(covered).toBe(size);
  });

  it('остаток от деления достаётся последней части', () => {
    const chunks = planChunks(10, 3);
    expect(chunks.map((chunk) => chunk.end - chunk.start + 1)).toEqual([3, 3, 4]);
  });

  it('не делит файл на части мельче байта', () => {
    expect(planChunks(3, 8)).toHaveLength(3);
    expect(planChunks(1, 4)).toEqual([{ start: 0, end: 0 }]);
  });

  it('одно соединение — один диапазон на весь файл', () => {
    expect(planChunks(5000, 1)).toEqual([{ start: 0, end: 4999 }]);
  });

  it('пустой файл не даёт диапазонов', () => {
    expect(planChunks(0, 4)).toEqual([]);
  });
});

describe('Параллельный провижининг', () => {
  it('ffmpeg и ffprobe помечены общим архивом', () => {
    // Оба приходят одним zip: без общего ключа параллельная загрузка запустила
    // бы две распаковки в один каталог.
    expect(TOOLS.ffmpeg.fetchKey).toBe(TOOLS.ffprobe.fetchKey);
    expect(TOOLS.ffmpeg.fetchKey).toBeTruthy();
  });

  it('у остальных компонентов свои загрузки', () => {
    const separate = (['yt-dlp', 'whisper-cli', 'piper'] as ToolName[]).map(
      (name) => TOOLS[name].fetchKey ?? name,
    );
    expect(new Set(separate).size).toBe(separate.length);
  });
});
