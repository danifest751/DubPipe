/** Isolated UI test data; never opens the user's config or working cache. */
import path from 'node:path';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseConfig } from '../src/config/load.js';
import { Workspace } from '../src/core/workspace.js';
import { startUiServer } from '../src/ui/server.js';

const root = path.resolve('output/playwright/runtime');
const media = path.join(root, 'media');
const cache = path.join(root, 'cache');
// Verify the fixed test-only directory before removing its previous fixture.
if (path.dirname(cache) !== root || !root.endsWith(path.join('output', 'playwright', 'runtime'))) throw new Error('Unsafe fixture path');
await rm(cache, { recursive: true, force: true });
await mkdir(media, { recursive: true });
const configPath = path.join(root, 'config.yaml');
await writeFile(configPath, JSON.stringify({ profile: 'offline', cache: { dir: cache }, server: { enabled: false }, separation: { enabled: false }, alignment: { enabled: false } }));
const config = parseConfig({ profile: 'offline', cache: { dir: cache }, server: { enabled: false }, separation: { enabled: false }, alignment: { enabled: false } }, 'UI test');
const bundledFfmpeg = path.resolve('.dubpipe/tools/ffmpeg/ffmpeg.exe');
const ffmpeg = process.env['DUBPIPE_FFMPEG'] ?? (existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
if (existsSync(bundledFfmpeg)) {
  const tools = path.join(cache, 'tools/ffmpeg');
  await mkdir(tools, { recursive: true });
  for (const tool of ['ffmpeg', 'ffprobe']) await copyFile(path.resolve(`.dubpipe/tools/ffmpeg/${tool}.exe`), path.join(tools, `${tool}.exe`));
}
for (const [name, color] of [['Interview', 'navy'], ['Lesson', 'teal']] as const) {
  const input = path.join(media, `${name}.mp4`);
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=8`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input], { stdio: 'ignore' });
  const workspace = await Workspace.open(input, config);
  if (name === 'Interview') {
    execFileSync(ffmpeg, ['-y', '-i', input, '-vn', '-acodec', 'pcm_s16le', '-ar', '48000', workspace.file('original.wav')], { stdio: 'ignore' });
    await copyFile(workspace.file('original.wav'), workspace.file('audio.wav'));
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.8', '-acodec', 'pcm_s16le', '-ar', String(config.tts.sample_rate), workspace.file('test-voice.wav')], { stdio: 'ignore' });
  }
  await workspace.writeJson(workspace.metaPath, { input, duration_seconds: 8, has_video: true, created_at: new Date().toISOString(), ...(name === 'Interview' ? { output: path.join(media, 'Interview.ru.mp4') } : {}) });
  await workspace.writeJson(workspace.segmentsPath, name === 'Interview' ? [0, 1, 2].map((id) => ({ id, start: id * 2, end: id * 2 + 1.8, text_en: ['Welcome to the interview.', 'This is our first question.', 'Thank you for watching.'][id], text_ru: ['Добро пожаловать на интервью.', 'Наш первый вопрос.', 'Спасибо за просмотр.'][id], speaker: 'speaker_0', tts_key: null, tts_file: workspace.file('test-voice.wav'), tts_duration: 1.8, aligned_file: null, aligned_duration: null, flags: [], tempo: null, shift_ms: null })) : []);
  await workspace.writeState({ fingerprints: name === 'Interview' ? Object.fromEntries(['s1','s2','s3','s4','s5','s6','s7'].map((id) => [id, 'fixture'])) : {}, segmentsHash: {} });
  if (name === 'Interview') await copyFile(input, path.join(media, 'Interview.ru.mp4'));
}
await writeFile(path.join(cache, 'ui-state.json'), JSON.stringify({ workingDir: media }));
const server = await startUiServer({ port: 4090, configPath });
await writeFile(path.join(root, 'server.json'), JSON.stringify({ url: server.url, token: server.token }));
console.log('Isolated UI fixture ready on port 4090');
process.on('SIGINT', () => { void server.close().then(() => process.exit()); });
