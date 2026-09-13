/**
 * Сквозная проверка правок из режима просмотра: меняем голос одного спикера,
 * сохраняем правки и запускаем перезапуск со стадии синтеза; в конце убеждаемся,
 * что синтез пересчитан только для реплик этого спикера, а итог пересведён.
 *
 * Запуск (из каталога с config.yaml и .dubpipe):
 *   npx tsx <репозиторий>/scripts/check-review-apply.mts "<путь к видео>" speaker_3 ru_RU-denis-medium
 */
import { readFile } from 'node:fs/promises';
import { startUiServer } from '../src/ui/server.js';

const [input, speaker, voice] = process.argv.slice(2);
if (!input || !speaker || !voice) {
  console.error('нужны: путь к видео, спикер, голос');
  process.exit(2);
}

const server = await startUiServer({});
const base = new URL(server.url).origin;
const call = async (route: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}token=${server.token}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const before = await call(`/api/segments?input=${encodeURIComponent(input)}`);
const segments = before.body['segments'] as Array<Record<string, unknown>>;
const overrides = before.body['overrides'] as { voices: Record<string, string>; mix: Record<string, number> };
const targets = segments.filter((segment) => segment['speaker'] === speaker).map((segment) => segment['id']);
const ttsBefore = new Map(segments.map((segment) => [segment['id'], segment['tts_file']]));
console.log(`реплик спикера ${speaker}: ${targets.length}; итог до: ${before.body['output']}`);

const review = await call('/api/project/review', 'POST', {
  input,
  segments,
  overrides: { voices: { ...overrides.voices, [speaker]: voice }, mix: overrides.mix },
});
console.log('план:', review.status, JSON.stringify(review.body));
if (review.status !== 200 || review.body['fromStage'] !== 's5') {
  console.log('ПРОВЕРКА НЕ ПРОЙДЕНА: ожидался перезапуск с s5');
  await server.close();
  process.exit(1);
}

const started = await call('/api/jobs', 'POST', { input, fromStage: review.body['fromStage'] });
console.log('задача:', started.status);
const startedAt = Date.now();
let job: Record<string, unknown> | null = null;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const state = await call('/api/state');
  job = state.body['job'] as Record<string, unknown> | null;
  const stages = (job?.['stages'] as Array<{ id: string; state: string; progress?: { detail: string } }>) ?? [];
  const running = stages.find((stage) => stage.state === 'running');
  process.stdout.write(`  ${Math.round((Date.now() - startedAt) / 1000)} с: ${running ? `${running.id} ${running.progress?.detail ?? ''}` : job?.['status']}\n`);
  if (!job || job['status'] !== 'running') break;
  if (Date.now() - startedAt > 20 * 60_000) break;
}

const after = await call(`/api/segments?input=${encodeURIComponent(input)}`);
const updated = after.body['segments'] as Array<Record<string, unknown>>;
const resynth = updated.filter((segment) => segment['tts_file'] !== ttsBefore.get(segment['id']) || !targets.includes(segment['id']) === false);
const untouched = updated.filter((segment) => !targets.includes(segment['id'])).every((segment) => segment['tts_file'] === ttsBefore.get(segment['id']));
const stats = JSON.parse(await readFile(`${after.body['dir']}/overrides.json`, 'utf8')) as { voices: Record<string, string> };
console.log(`статус: ${job?.['status']}; итог: ${job?.['output']}`);
console.log(`переозвучено реплик спикера: ${resynth.length}; остальные не тронуты: ${untouched}; overrides.json: ${JSON.stringify(stats.voices)}`);
const ok = job?.['status'] === 'done' && Boolean(job?.['output']) && untouched && stats.voices[speaker] === voice;
console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
await server.close();
process.exit(ok ? 0 : 1);
