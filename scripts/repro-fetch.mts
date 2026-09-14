/**
 * Воспроизведение сценария «догрузить недостающее» на свежем служебном каталоге.
 *
 * Копирует уже загруженные компоненты, кроме ffmpeg, в пустой временный каталог,
 * запускает сервер интерфейса с ним и нажимает «Догрузить» через API — ровно то,
 * что делает пользователь. Все события о ходе загрузки печатаются как есть.
 *
 * Запуск: npx tsx scripts/repro-fetch.mts
 */
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectTools = path.resolve('.dubpipe', 'tools');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'dubpipe-repro-'));
const sandboxTools = path.join(sandbox, '.dubpipe', 'tools');
await mkdir(sandboxTools, { recursive: true });

// Режимы: по умолчанию не хватает архива ffmpeg; REPRO=weights — программы
// на месте, не хватает весов модели, VAD и голоса (как на свежей установке
// после первой догрузки). Модель tiny — чтобы не тянуть 465 МБ ради проверки.
const mode = process.env['REPRO'] ?? 'ffmpeg';
const copy = mode === 'weights' ? ['ffmpeg', 'yt-dlp', 'whisper', 'piper'] : ['yt-dlp', 'whisper', 'piper'];
for (const name of copy) {
  const from = path.join(projectTools, name);
  if (existsSync(from)) await cp(from, path.join(sandboxTools, name), { recursive: true });
}
if (mode === 'weights') {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(sandbox, 'config.yaml'), 'asr:\n  model: tiny\n', 'utf8');
}
console.log('песочница:', sandbox, '| режим:', mode);

// Сервер берёт служебный каталог от текущего каталога процесса.
process.chdir(sandbox);
const { startUiServer } = await import('../src/ui/server.js');
const server = await startUiServer({ port: 0 });
const base = `http://127.0.0.1:${server.port}`;
const headers = { 'X-DubPipe-Token': server.token, 'Content-Type': 'application/json' };

const before = ((await (await fetch(`${base}/api/readiness`, { headers })).json()) as Record<string, any>);
console.log('до:', before.summary);

// Слушаем поток событий, как это делает страница.
const controller = new AbortController();
const stream = await fetch(`${base}/api/events`, { headers, signal: controller.signal });
const reader = stream.body!.getReader();
const decoder = new TextDecoder();
// Заглушка вместо null: анализ потока управления не знает, что обработчик
// вызовется позже, и считает переменную навсегда пустой.
let finished: () => void = () => undefined;
const done = new Promise<void>((resolve) => {
  finished = resolve;
});

void (async () => {
  let buffer = '';
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /event: (\w+)/.exec(block)?.[1];
      const data = /data: (.*)/.exec(block)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === 'progress') {
        const pct = payload.percent === null ? '…' : `${payload.percent}%`;
        console.log(`  [${payload.kind}] ${payload.label}: ${payload.status} ${pct}${payload.detail ? ' — ' + payload.detail : ''}`);
      }
      if (event === 'log' && (payload.level === 'error' || payload.level === 'warn')) {
        console.log(`  [лог/${payload.level}] ${payload.text}`);
      }
      if (event === 'readiness') {
        console.log('после:', payload.summary);
        finished();
      }
    }
  }
})().catch(() => undefined);

const started = Date.now();
const response = await fetch(`${base}/api/environment/fetch`, { method: 'POST', headers });
console.log('ответ на «Догрузить»:', response.status);

await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 15 * 60_000))]);
console.log(`заняло ${((Date.now() - started) / 1000).toFixed(0)} с`);

console.log('содержимое tools/ffmpeg:', existsSync(path.join(sandboxTools, 'ffmpeg')) ? await readdir(path.join(sandboxTools, 'ffmpeg')) : 'каталога нет');
console.log('остатки staging:', (await readdir(sandboxTools)).filter((name) => name.startsWith('.staging')));

controller.abort();
await server.close();
// Windows отпускает свежезаписанные файлы не сразу: без пауз rmdir даёт EBUSY,
// и в Temp остаются песочницы по 100 МБ.
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    await rm(sandbox, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
process.exit(0);
