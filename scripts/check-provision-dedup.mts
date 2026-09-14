/**
 * Проверка: ffmpeg и ffprobe приходят одним архивом, и при одновременном
 * провижининге распаковка обязана запуститься ровно один раз.
 *
 * Загрузка подменена заглушкой со счётчиком — сеть не нужна.
 * Запуск: npx tsx scripts/check-provision-dedup.mts
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, provisionTool, findTool, resetToolCache , type ToolName } from '../src/util/tools.js';

const toolsDir = await mkdtemp(path.join(os.tmpdir(), 'dubpipe-dedup-'));
let fetches = 0;

const fakeBundle = async (dir: string): Promise<void> => {
  fetches++;
  console.log(`  распаковка №${fetches} началась`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await mkdir(path.join(dir, 'ffmpeg'), { recursive: true });
  await writeFile(path.join(dir, 'ffmpeg', 'ffmpeg.exe'), 'x');
  await writeFile(path.join(dir, 'ffmpeg', 'ffprobe.exe'), 'x');
  console.log(`  распаковка №${fetches} завершилась`);
};

TOOLS.ffmpeg.fetch = fakeBundle;
TOOLS.ffprobe.fetch = fakeBundle;

// Как делает обработчик «Догрузить»: сначала проверка, потом всё параллельно.
const missing = [];
for (const name of ['ffmpeg', 'ffprobe'] as const) {
  if (!(await findTool(name, toolsDir))) missing.push(name);
}
console.log('не хватает:', missing.join(', '));

const results = await Promise.allSettled(missing.map((name) => provisionTool(name as ToolName, toolsDir)));
for (const [index, result] of results.entries()) {
  console.log(`  ${missing[index]}: ${result.status === 'fulfilled' ? 'найден ' + path.basename(result.value.path) : 'ОШИБКА ' + (result.reason as Error).message}`);
}

console.log(`итого запусков распаковки: ${fetches} (ожидается 1)`);
resetToolCache();
await rm(toolsDir, { recursive: true, force: true });
process.exit(fetches === 1 && results.every((r) => r.status === 'fulfilled') ? 0 : 1);
