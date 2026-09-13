import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, provisionTool, findTool, resetToolCache } from '../src/util/tools.js';

/**
 * ffmpeg и ffprobe приходят одним архивом. Ошибка была ровно здесь:
 * параллельный провижининг запускал распаковку дважды (вторая падала с EBUSY
 * на файле, который двигала первая), а после распаковки сосед по архиву
 * оставался в кэше «не найденным» и тянул те же 106 МБ ещё раз.
 *
 * Загрузка подменена заглушкой — сеть не нужна.
 */

let toolsDir: string;
let fetches: number;
const originalFetch = { ffmpeg: TOOLS.ffmpeg.fetch, ffprobe: TOOLS.ffprobe.fetch };

const fakeBundle = async (dir: string): Promise<void> => {
  fetches++;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await mkdir(path.join(dir, 'ffmpeg'), { recursive: true });
  await writeFile(path.join(dir, 'ffmpeg', TOOLS.ffmpeg.binary), 'x');
  await writeFile(path.join(dir, 'ffmpeg', TOOLS.ffprobe.binary), 'x');
};

beforeEach(async () => {
  toolsDir = await mkdtemp(path.join(os.tmpdir(), 'dubpipe-provision-'));
  fetches = 0;
  resetToolCache();
  TOOLS.ffmpeg.fetch = fakeBundle;
  TOOLS.ffprobe.fetch = fakeBundle;
});

afterEach(async () => {
  TOOLS.ffmpeg.fetch = originalFetch.ffmpeg;
  TOOLS.ffprobe.fetch = originalFetch.ffprobe;
  resetToolCache();
  await rm(toolsDir, { recursive: true, force: true });
});

describe('Провижининг: один архив на две программы', () => {
  it('параллельные вызовы для ffmpeg и ffprobe распаковывают архив один раз', async () => {
    // Предварительная проверка, как в обработчике «Догрузить»: кэширует «не найден».
    expect(await findTool('ffmpeg', toolsDir)).toBeNull();
    expect(await findTool('ffprobe', toolsDir)).toBeNull();

    const [ffmpeg, ffprobe] = await Promise.all([
      provisionTool('ffmpeg', toolsDir),
      provisionTool('ffprobe', toolsDir),
    ]);

    expect(fetches).toBe(1);
    expect(path.basename(ffmpeg.path)).toBe(TOOLS.ffmpeg.binary);
    expect(path.basename(ffprobe.path)).toBe(TOOLS.ffprobe.binary);
  });

  it('после распаковки сосед по архиву виден без повторной загрузки', async () => {
    await findTool('ffprobe', toolsDir); // попадает в кэш как отсутствующий
    await provisionTool('ffmpeg', toolsDir);
    expect(fetches).toBe(1);

    // Именно этот вызов раньше качал архив заново.
    const ffprobe = await provisionTool('ffprobe', toolsDir);
    expect(fetches).toBe(1);
    expect(ffprobe.source).toBe('local');
  });

  it('уже загруженный компонент не загружается снова', async () => {
    await provisionTool('ffmpeg', toolsDir);
    await provisionTool('ffmpeg', toolsDir);
    expect(fetches).toBe(1);
  });
});
