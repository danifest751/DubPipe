import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWavFormat, wavDuration } from '../src/util/wav.js';

/**
 * Заголовок читался только в первых 4 КБ файла. WAV с крупными метаданными —
 * обложкой, длинным блоком LIST — объявлялся негодным: блок data лежал дальше.
 * На нашем материале это не стреляло, потому что все WAV пишет ffmpeg, но тот же
 * разбор жил в определителе тона во второй, правильной версии.
 */

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Собирает WAV 16 кГц моно 16 бит с блоком метаданных заданного размера перед данными. */
async function wavWithMetadata(metadataBytes: number, frames: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dubpipe-wav-'));
  roots.push(root);
  const file = path.join(root, 'sample.wav');

  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // моно
  fmt.writeUInt32LE(16_000, 12);
  fmt.writeUInt32LE(32_000, 16); // байт в секунду
  fmt.writeUInt16LE(2, 20); // выравнивание блока
  fmt.writeUInt16LE(16, 22); // бит на отсчёт

  const meta = Buffer.alloc(8 + metadataBytes);
  meta.write('LIST', 0, 'ascii');
  meta.writeUInt32LE(metadataBytes, 4);

  const data = Buffer.alloc(8 + frames * 2);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(frames * 2, 4);

  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, meta, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);

  await writeFile(file, Buffer.concat([riff, body]));
  return file;
}

describe('чтение заголовка WAV', () => {
  it('находит данные за метаданными крупнее прежнего предела в 4 КБ', async () => {
    const file = await wavWithMetadata(8192, 16_000);
    const format = await readWavFormat(file);
    expect(format.sampleRate).toBe(16_000);
    expect(format.channels).toBe(1);
    expect(format.bitsPerSample).toBe(16);
    expect(format.dataLength).toBe(32_000);
    expect(await wavDuration(file)).toBeCloseTo(1, 6);
  });

  it('обычный файл без метаданных читается как прежде', async () => {
    const file = await wavWithMetadata(0, 8000);
    const format = await readWavFormat(file);
    expect(format.sampleRate).toBe(16_000);
    expect(await wavDuration(file)).toBeCloseTo(0.5, 6);
  });

  it('файл без блока data честно отвергается', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dubpipe-wav-'));
    roots.push(root);
    const file = path.join(root, 'broken.wav');
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(4, 4);
    riff.write('WAVE', 8, 'ascii');
    await writeFile(file, riff);
    await expect(readWavFormat(file)).rejects.toThrow('не найден блок data');
  });

  it('не WAV — отдельная ошибка, а не молчание', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dubpipe-wav-'));
    roots.push(root);
    const file = path.join(root, 'notawav.bin');
    await writeFile(file, Buffer.alloc(64));
    await expect(readWavFormat(file)).rejects.toThrow('не является WAV');
  });
});
