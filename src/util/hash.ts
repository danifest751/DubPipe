import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable stringify so key order never changes a fingerprint. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Streaming file hash: keeps memory flat on multi-gigabyte inputs (SPEC §7). */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * Identity of the pipeline input. Local files are hashed by content; URLs by the
 * URL string itself, since the remote bytes are not available before download.
 */
export async function hashInput(input: string): Promise<string> {
  if (isUrl(input)) return sha256(`url:${input}`);
  try {
    const info = await stat(input);
    // Hash content for small inputs; for large media, size+mtime+path is enough
    // to detect change and avoids reading gigabytes on every run.
    if (info.size <= 64 * 1024 * 1024) return await hashFile(input);
    return sha256(`file:${input}:${info.size}:${info.mtimeMs}`);
  } catch {
    return sha256(`missing:${input}`);
  }
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function shortHash(hash: string, length = 12): string {
  return hash.slice(0, length);
}
