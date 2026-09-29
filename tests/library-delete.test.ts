import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';

/**
 * Удаление видео из раздела «Видео».
 *
 * Удаляют гигабайты, поэтому сервер сам проверяет, что именно удаляет: только
 * медиафайл из выбранной папки, не то, что сейчас обрабатывается. Рабочие
 * файлы дубляжа уходят вместе с исходником — без него они бесполезны.
 * Всё в своём временном каталоге: общий config.yaml и .dubpipe не трогаются.
 */

const root = mkdtempSync(path.join(tmpdir(), 'dubpipe-delete-'));
const media = path.join(root, 'видео');
const cache = path.join(root, 'cache');
const configPath = path.join(root, 'config.yaml');
let server: UiServerHandle;

const call = (route: string, method: string, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${route}?token=${server.token}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  process.env['DUBPIPE_NO_TRASH'] = '1';
  mkdirSync(media, { recursive: true });
  writeFileSync(configPath, `cache:\n  dir: ${JSON.stringify(cache)}\n`, 'utf8');
  server = await startUiServer({ port: 0, configPath });
  const saved = await call('/api/workdir', 'PUT', { dir: media });
  expect(saved.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await server?.close();
});

describe('удаление видео', () => {
  it('удаляет файл вместе с рабочими файлами его дубляжа', async () => {
    const film = path.join(media, 'Фильм.mp4');
    writeFileSync(film, Buffer.alloc(1024));
    const workspace = path.join(cache, 'abc123');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'meta.json'), JSON.stringify({ input: film, duration_seconds: 1, has_video: true }));
    writeFileSync(path.join(workspace, 'segments.json'), '[]');

    const response = await call('/api/library/delete', 'POST', { path: film });
    const body = (await response.json()) as { ok?: boolean; how?: string; workspaceBytes?: number };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(existsSync(film)).toBe(false);
    expect(existsSync(workspace)).toBe(false);
    expect(body.workspaceBytes).toBeGreaterThan(0);
  });

  it('не удаляет ничего за пределами выбранной папки', async () => {
    const outside = path.join(root, 'чужой.mp4');
    writeFileSync(outside, 'x');
    const response = await call('/api/library/delete', 'POST', { path: outside });
    expect(response.status).toBe(403);
    expect(existsSync(outside)).toBe(true);
    // И через «..» из выбранной папки — тоже.
    const sneaky = await call('/api/library/delete', 'POST', { path: path.join(media, '..', 'чужой.mp4') });
    expect(sneaky.status).toBe(403);
    expect(existsSync(outside)).toBe(true);
  });

  it('не удаляет то, что не видео', async () => {
    const note = path.join(media, 'заметки.txt');
    writeFileSync(note, 'x');
    const response = await call('/api/library/delete', 'POST', { path: note });
    expect(response.status).toBe(400);
    expect(existsSync(note)).toBe(true);
  });
});
