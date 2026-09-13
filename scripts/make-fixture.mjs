#!/usr/bin/env node
/**
 * Builds the test fixture required by SPEC §10: a 10-second clip with two
 * speakers over background music, plus the reference markup in golden.json.
 *
 * The speech is synthesised locally with piper, so the fixture is fully
 * reproducible and carries no third-party rights: every boundary in golden.json
 * is a placement we chose, not a human annotation.
 *
 * Usage: node scripts/make-fixture.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, '.dubpipe', 'tools');
const voices = path.join(root, '.dubpipe', 'models', 'voices');
const outDir = path.join(root, 'tests', 'fixtures');
const work = path.join(outDir, '.build');

const FFMPEG = path.join(tools, 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(tools, 'ffmpeg', 'ffprobe.exe');
const PIPER = path.join(tools, 'piper', 'piper.exe');

const LINES = [
  { speaker: 'speaker_0', voice: 'en_US-lessac-medium', text: 'So what do you think about the new plan?' },
  { speaker: 'speaker_1', voice: 'en_GB-alan-medium', text: 'Honestly, it looks better than the last one.' },
  { speaker: 'speaker_0', voice: 'en_US-lessac-medium', text: 'That is not a high bar.' },
  { speaker: 'speaker_1', voice: 'en_GB-alan-medium', text: 'Fair enough. Let us ship it and see.' },
];

const LEAD_IN = 0.6;
const GAP = 0.45;

function sh(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function durationOf(file) {
  const out = sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(out.trim());
}

for (const required of [FFMPEG, FFPROBE, PIPER]) {
  if (!existsSync(required)) {
    console.error(`Нет необходимого инструмента: ${required}\nВыполните: npx tsx src/cli.ts doctor --fetch`);
    process.exit(1);
  }
}

mkdirSync(work, { recursive: true });

// 1. Synthesize each line and measure how long it actually is.
const placed = [];
let cursor = LEAD_IN;
for (const [index, line] of LINES.entries()) {
  const wav = path.join(work, `line${index}.wav`);
  const model = path.join(voices, `${line.voice}.onnx`);
  if (!existsSync(model)) {
    console.error(`Нет голоса ${model}`);
    process.exit(1);
  }
  sh(PIPER, ['-m', model, '-f', wav, '--sentence_silence', '0', '-q'], { input: line.text });
  const duration = durationOf(wav);
  placed.push({ ...line, file: wav, start: Number(cursor.toFixed(3)), end: Number((cursor + duration).toFixed(3)) });
  cursor += duration + GAP;
}

const total = Math.ceil(cursor + 0.4);
console.log(`Реплик: ${placed.length}, длительность ролика: ${total} с`);

// 2. Background music: a quiet sustained chord, so S4 has something to preserve.
const music = path.join(work, 'music.wav');
sh(FFMPEG, [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', `sine=frequency=220:duration=${total}`,
  '-f', 'lavfi', '-i', `sine=frequency=277:duration=${total}`,
  '-f', 'lavfi', '-i', `sine=frequency=330:duration=${total}`,
  '-filter_complex', '[0][1][2]amix=inputs=3:duration=longest,volume=0.08,aresample=48000',
  '-ac', '2', music,
]);

// 3. Lay the speech onto the timeline at the measured offsets.
const inputs = ['-i', music];
for (const line of placed) inputs.push('-i', line.file);

const filters = placed
  .map((line, index) => `[${index + 1}:a]aresample=48000,adelay=${Math.round(line.start * 1000)}|${Math.round(line.start * 1000)},volume=1.6[s${index}]`)
  .join(';');
const mixInputs = ['[0:a]', ...placed.map((_, index) => `[s${index}]`)].join('');
const mixed = path.join(work, 'mixed.wav');

sh(FFMPEG, [
  '-y', '-v', 'error', ...inputs,
  '-filter_complex', `${filters};${mixInputs}amix=inputs=${placed.length + 1}:duration=first:normalize=0[out]`,
  '-map', '[out]', '-ac', '2', '-ar', '48000', '-t', String(total), mixed,
]);

// 4. Mux with a simple video stream so the fixture exercises the video path.
const sample = path.join(outDir, 'sample.mp4');
sh(FFMPEG, [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', `color=c=0x202830:s=640x360:d=${total}:r=25`,
  '-i', mixed,
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', sample,
]);

// 5. Reference markup: boundaries are exact by construction.
const golden = {
  description: 'Эталонная разметка тестового ролика (ТЗ §10): два спикера, фоновая музыка',
  source: 'tests/fixtures/sample.mp4',
  generated_by: 'scripts/make-fixture.mjs (piper, локальный синтез)',
  duration_seconds: total,
  tolerance_ms: 250,
  segments: placed.map(({ start, end, speaker, text }) => ({ start, end, speaker, text_en: text })),
};
writeFileSync(path.join(outDir, 'golden.json'), `${JSON.stringify(golden, null, 2)}\n`, 'utf8');

console.log(`Готово: ${sample}`);
for (const line of placed) console.log(`  ${line.start.toFixed(2)}–${line.end.toFixed(2)}  ${line.speaker}  ${line.text}`);
