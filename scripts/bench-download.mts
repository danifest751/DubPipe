/**
 * Замер выигрыша от многопоточной загрузки.
 * Запуск: npx tsx scripts/bench-download.mts
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { downloadFile } from '../src/util/download.js';

const URL_UNDER_TEST = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const SIZE_MB = 106.1;
const dir = process.env['TEMP'] ?? '.';

async function measure(label: string, connections: number): Promise<number> {
  const target = path.join(dir, `bench-${connections}.zip`);
  await rm(target, { force: true });

  const started = Date.now();
  await downloadFile(URL_UNDER_TEST, target, { label, connections, timeoutMs: 900_000 });
  const seconds = (Date.now() - started) / 1000;

  console.log(`${label}: ${seconds.toFixed(1)} с, ${(SIZE_MB / seconds).toFixed(1)} МБ/с`);
  await rm(target, { force: true });
  return seconds;
}

const single = await measure('одно соединение   ', 1);
const parallel = await measure('четыре соединения ', 4);
console.log(`ускорение: ${(single / parallel).toFixed(2)}x`);
