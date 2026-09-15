import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config/load.js';
import { Workspace } from '../src/core/workspace.js';
import { rememberTokenRate, tokenRateFor } from '../src/core/translation-cost.js';

/**
 * Стоимость перевода оценивалась прикидкой «запрос вдвое длиннее текста» и
 * ошибалась в двадцать раз: третий эпизод по ней выходил в 1.2 цента, а стоил
 * 27. Теперь отношение меряется на прогонах, а до первого замера оценки нет.
 */

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'dubpipe-cost-'));
  roots.push(root);
  const input = path.join(root, 'episode.mp4');
  await writeFile(input, 'вход', 'utf8');
  return await Workspace.open(input, parseConfig({ cache: { dir: path.join(root, 'cache') } }, 'тест'));
}

const MODEL = 'anthropic/claude-sonnet-4.5';

describe('замер расхода токенов на перевод', () => {
  it('до первого прогона отношения нет', async () => {
    const workspace = await freshWorkspace();
    expect(await tokenRateFor(workspace, MODEL)).toBeNull();
  });

  it('прогон запоминает отношение, и оно читается обратно', async () => {
    const workspace = await freshWorkspace();
    await rememberTokenRate(workspace, MODEL, { chars: 1766, promptTokens: 21_200, completionTokens: 2000 });
    const rate = await tokenRateFor(workspace, MODEL);
    expect(rate).not.toBeNull();
    expect(rate!.prompt_per_char).toBeCloseTo(12.0, 1);
    expect(rate!.completion_per_char).toBeCloseTo(1.13, 2);
  });

  it('короткий прогон замером не считается', async () => {
    const workspace = await freshWorkspace();
    await rememberTokenRate(workspace, MODEL, { chars: 142, promptTokens: 900, completionTokens: 90 });
    expect(await tokenRateFor(workspace, MODEL)).toBeNull();
  });

  it('модели не путаются между собой', async () => {
    const workspace = await freshWorkspace();
    await rememberTokenRate(workspace, MODEL, { chars: 1766, promptTokens: 21_200, completionTokens: 2000 });
    expect(await tokenRateFor(workspace, 'mistralai/nemo')).toBeNull();
  });

  it('замер держит порядок реальной стоимости', async () => {
    // Третий эпизод: 1766 знаков исходника, sonnet-4.5, фактически $0.27.
    const workspace = await freshWorkspace();
    await rememberTokenRate(workspace, MODEL, { chars: 1766, promptTokens: 21_200, completionTokens: 2000 });
    const rate = (await tokenRateFor(workspace, MODEL))!;
    const usd = 1766 * (rate.prompt_per_char * 3e-6 + rate.completion_per_char * 15e-6);
    expect(usd).toBeGreaterThan(0.08);
    expect(usd).toBeLessThan(0.3);
  });
});
