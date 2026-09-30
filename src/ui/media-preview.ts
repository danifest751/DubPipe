import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { findTool } from '../util/tools.js';
import { sha256 } from '../util/hash.js';

const execute = promisify(execFile);

/** Превью сохраняются в кэше; один FFmpeg одновременно не мешает обработке видео. */
export function createPreviewLoader(cacheRoot: string) {
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<string>>();
  return async (input: string): Promise<string> => {
    const info = await stat(input);
    if (!info.isFile()) throw new Error('Ожидался медиафайл');
    const key = sha256(`${input}:${info.size}:${info.mtimeMs}`);
    const output = path.join(cacheRoot, 'previews', `${key}.jpg`);
    if (existsSync(output)) return output;
    const existing = pending.get(key);
    if (existing) return existing;
    const task = queue.then(async () => {
      const ffmpeg = await findTool('ffmpeg', path.join(cacheRoot, 'tools'));
      if (!ffmpeg) throw new Error('FFmpeg не установлен');
      await mkdir(path.dirname(output), { recursive: true });
      const temporary = path.join(path.dirname(output), `${key}-${randomUUID()}.jpg`);
      try {
        await execute(ffmpeg.path, ['-nostdin', '-y', '-threads', '1', '-i', input, '-frames:v', '1', '-vf',
          'scale=384:216:force_original_aspect_ratio=increase,crop=384:216', '-q:v', '4', temporary],
        { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 });
        if (!existsSync(temporary)) throw new Error('В файле нет видеокадра');
        await rename(temporary, output);
      } finally {
        await rm(temporary, { force: true });
      }
      return output;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    queue = task.catch(() => {});
    return task;
  };
}
