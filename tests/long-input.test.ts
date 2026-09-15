import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config/load.js';
import { runPipeline } from '../src/core/pipeline.js';
import { Workspace, TOOL_VERSION } from '../src/core/workspace.js';
import { LONG_INPUT_SECONDS } from '../src/stages/s1-input.js';
import { CancelledError } from '../src/core/cancel.js';

/**
 * Ключ `--yes` обещал «не переспрашивать на длинных входах», а спрашивать было
 * некому: подтверждения не существовало, ключ не читался нигде. Теперь оно есть,
 * и эти проверки держат обещание.
 *
 * Прогон здесь не доходит ни до одной стадии: длительность берётся из meta.json
 * прошлого прогона, и отказ останавливает работу раньше, чем понадобится ffmpeg.
 */

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Рабочий каталог с готовым meta.json заданной длительности. */
async function workspaceWithDuration(durationSeconds: number): Promise<{ input: string; cacheDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dubpipe-long-'));
  roots.push(root);
  const input = path.join(root, 'episode.mp4');
  await writeFile(input, 'не настоящее видео: до стадий дело не дойдёт', 'utf8');

  const cacheDir = path.join(root, 'cache');
  const config = parseConfig({ cache: { dir: cacheDir } }, 'тест');
  const workspace = await Workspace.open(input, config);
  await workspace.writeMeta({
    input,
    input_hash: workspace.inputHash,
    duration_seconds: durationSeconds,
    created_at: new Date().toISOString(),
    tool_version: TOOL_VERSION,
    has_video: true,
    stage_fingerprints: {},
  });
  return { input, cacheDir };
}

const runWith = async (
  durationSeconds: number,
  confirm: ((info: { durationSeconds: number; input: string }) => Promise<boolean>) | undefined,
) => {
  const { input, cacheDir } = await workspaceWithDuration(durationSeconds);
  return await runPipeline({
    input,
    config: parseConfig({ cache: { dir: cacheDir } }, 'тест'),
    toStage: 's1',
    ...(confirm ? { confirm } : {}),
  });
};

describe('длинный вход: спросить, прежде чем тратить часы', () => {
  it('на длинном входе спрашивает и останавливается на отказ', async () => {
    const asked: number[] = [];
    await expect(
      runWith(LONG_INPUT_SECONDS + 1, async ({ durationSeconds }) => {
        asked.push(durationSeconds);
        return false;
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(asked).toEqual([LONG_INPUT_SECONDS + 1]);
  });

  it('на коротком входе не спрашивает вовсе', async () => {
    let asked = 0;
    // Прогон дойдёт до ffmpeg и упадёт — важно лишь то, что вопроса не было.
    await runWith(600, async () => {
      asked += 1;
      return true;
    }).catch(() => undefined);
    expect(asked).toBe(0);
  });

  it('без обработчика (это и есть --yes) прогон не спрашивает и не останавливается', async () => {
    const result = await runWith(LONG_INPUT_SECONDS + 1, undefined).catch((error: unknown) => error);
    // Дальше он упирается в ненастоящее видео, но останов по отказу — не наш случай.
    expect(result).not.toBeInstanceOf(CancelledError);
  });
});
