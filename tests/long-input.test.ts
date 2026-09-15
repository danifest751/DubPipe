import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
  /*
   * Файла намеренно нет на диске.
   *
   * Там, где подтверждение получено, прогон идёт дальше и упирается в S1 —
   * а ей для настоящего файла понадобились бы ffprobe и ffmpeg, то есть
   * загрузка из сети. Правило проекта: тестам не нужны ни сеть, ни ffmpeg.
   * С отсутствующим файлом S1 отказывается сразу, на проверке существования,
   * и проверяемое здесь — был вопрос или нет — от этого не зависит.
   */
  const input = path.join(root, 'episode.mp4');

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
    // Прогон упрётся в отсутствующий файл — важно лишь то, что вопроса не было.
    await runWith(600, async () => {
      asked += 1;
      return true;
    }).catch(() => undefined);
    expect(asked).toBe(0);
  });

  it('без обработчика (это и есть --yes) прогон не спрашивает и не останавливается', async () => {
    const result = await runWith(LONG_INPUT_SECONDS + 1, undefined).catch((error: unknown) => error);
    // Дальше он упирается в отсутствующий файл, но останов по отказу — не наш случай.
    expect(result).not.toBeInstanceOf(CancelledError);
  });
});
