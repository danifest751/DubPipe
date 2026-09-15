/**
 * Сквозная проверка остановки: запускаем распознавание на реальном эпизоде,
 * через несколько секунд жмём «Остановить» и смотрим, как быстро задача
 * действительно встала и остались ли живые процессы whisper.
 *
 * Запуск (из каталога с config.yaml и .dubpipe):
 *   npx tsx <репозиторий>/scripts/check-cancel.mts "<путь к видео>" [s2|s5]
 */
import { execFileSync } from 'node:child_process';
import { startUiServer } from '../src/ui/server.js';

const input = process.argv[2];
const stage = (process.argv[3] ?? 's2') as 's2' | 's5';
if (!input) {
  console.error('нужен путь к видео; второй аргумент — стадия (s2 или s5)');
  process.exit(2);
}
const PROCESS_NAME = stage === 's5' ? 'piper.exe' : 'whisper-cli.exe';

const server = await startUiServer({});
const base = new URL(server.url).origin;
const call = async (route: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}token=${server.token}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
};

const running = () => {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${PROCESS_NAME}`, '/NH'], { encoding: 'utf8' });
    // Имя процесса попадает в регулярное выражение, поэтому его спецсимволы
    // экранируются целиком. Раньше здесь стояло PROCESS_NAME.replace('.', '\.'),
    // что в обычной строке означает просто точку: экранирования не было.
    const quoted = PROCESS_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (out.match(new RegExp(quoted, 'g')) ?? []).length;
  } catch {
    return 0;
  }
};

await call('/api/jobs', 'POST', { input, fromStage: stage, toStage: stage });
console.log(`задача запущена (${stage}), жду появления процесса ${PROCESS_NAME}…`);
let sawProcess = false;
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (running() > 0) { sawProcess = true; break; }
}
console.log(`процесс ${PROCESS_NAME} запущен: ${sawProcess}`);

const askedAt = Date.now();
const answer = await call('/api/jobs/cancel', 'POST');
console.log('ответ на остановку:', JSON.stringify(answer));

let stoppedAfter = -1;
let status = '';
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const state = await call('/api/state');
  const job = state['job'] as Record<string, unknown> | null;
  status = String(job?.['status'] ?? '');
  if (status && status !== 'running') { stoppedAfter = Date.now() - askedAt; break; }
}
await new Promise((resolve) => setTimeout(resolve, 1500));
const leftover = running();
console.log(`статус: ${status}; остановилась за ${stoppedAfter} мс; живых процессов ${PROCESS_NAME} после: ${leftover}`);

const ok = sawProcess && status === 'cancelled' && stoppedAfter >= 0 && stoppedAfter < 5000 && leftover === 0;
console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
await server.close();
process.exit(ok ? 0 : 1);
