/**
 * Пол голосов спикеров по готовой диаризации рабочего каталога: печатает
 * медиану основного тона и вердикт для каждого спикера.
 *
 * Запуск: npx tsx scripts/check-gender.mts <рабочий каталог видео> [--write]  (--write обновляет speakers.json)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { profileSpeakers } from '../src/providers/diarization/gender.js';
import { speakerNames, type DiarizationTurn } from '../src/providers/diarization/pyannote.js';

const ws = process.argv[2];
if (!ws) {
  console.error('нужен путь к рабочему каталогу видео (.dubpipe/<hash>)');
  process.exit(2);
}
const { turns } = JSON.parse(await readFile(path.join(ws, 'diarization.json'), 'utf8')) as { turns: DiarizationTurn[] };
const names = speakerNames(turns);
const intervals = turns.map((turn) => ({ ...turn, speaker: names.get(turn.speaker) ?? turn.speaker }));
const started = Date.now();
const profiles = await profileSpeakers(path.join(ws, 'audio16k.wav'), intervals);
for (const [speaker, profile] of [...profiles].sort()) console.log(speaker, JSON.stringify(profile));
if (process.argv.includes('--write')) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(ws, 'speakers.json'), JSON.stringify(Object.fromEntries(profiles), null, 2), 'utf8');
  console.log('speakers.json перезаписан');
}
console.log(`время: ${Date.now() - started} мс`);
