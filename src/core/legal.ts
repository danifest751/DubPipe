import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Legal notice shown on first run (SPEC §1.3, §6). */

export const LEGAL_NOTICE = [
  'DubPipe создаёт дубляж ИСКЛЮЧИТЕЛЬНО для личного просмотра.',
  'Публикация или распространение полученной дорожки нарушает права правообладателя',
  'и правила платформ. Инструмент намеренно не умеет ничего никуда выгружать.',
].join('\n');

function stampPath(): string {
  const base = process.env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(base, 'dubpipe', 'accepted-notice');
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prints the notice once per machine; returns true when it was shown. */
export async function showLegalNoticeOnce(force = false): Promise<boolean> {
  const stamp = stampPath();
  if (!force && (await exists(stamp))) return false;

  process.stderr.write(`\n${'─'.repeat(72)}\n${LEGAL_NOTICE}\n${'─'.repeat(72)}\n\n`);

  try {
    await mkdir(path.dirname(stamp), { recursive: true });
    await writeFile(stamp, new Date().toISOString(), 'utf8');
  } catch {
    // A read-only home must not break the run; the notice simply shows again.
  }
  return true;
}
