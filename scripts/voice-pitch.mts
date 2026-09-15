/**
 * Тон голосов синтеза — тем же определителем, каким проект меряет актёров.
 *
 * Нужен, чтобы героине доставался не «женский голос вообще», а тот, что ближе
 * по высоте к её собственному: у пятого эпизода две героини на 195 и 176 Гц,
 * и одним голосом на обеих они сливаются в одну.
 *
 * Использование: npx tsx scripts/voice-pitch.mts <каталог с wav> [--match 195,176]
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { profileSpeakers } from '../src/providers/diarization/gender.js';
import { wavDuration } from '../src/util/wav.js';

const dir = process.argv[2];
if (!dir) {
  console.error('укажите каталог с пробами: npx tsx scripts/voice-pitch.mts <dir>');
  process.exit(2);
}
const matchArg = process.argv.indexOf('--match');
const targets: number[] = matchArg > 0 ? (process.argv[matchArg + 1] ?? '').split(',').map(Number).filter(Boolean) : [];

const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.wav')).sort();
const measured: Array<{ name: string; f0: number; p25: number; p75: number; gender: string; voiced: number }> = [];

for (const file of files) {
  const full = path.join(dir, file);
  const duration = await wavDuration(full);
  const profiles = await profileSpeakers(full, [{ start: 0, end: duration, speaker: 'x' }]);
  const profile = profiles.get('x');
  if (!profile?.f0) {
    console.log(`${file.padEnd(24)} тон не измерился`);
    continue;
  }
  measured.push({
    name: path.basename(file, '.wav'),
    f0: profile.f0,
    p25: profile.p25 ?? profile.f0,
    p75: profile.p75 ?? profile.f0,
    gender: profile.gender,
    voiced: profile.voicedSeconds,
  });
}

measured.sort((a, b) => a.f0 - b.f0);
console.log('\nголос                     тон  квартили   пол  звонкой речи');
for (const voice of measured) {
  console.log(
    `${voice.name.padEnd(24)} ${String(voice.f0).padStart(4)} Гц  ${String(voice.p25).padStart(3)}–${String(voice.p75).padEnd(3)}  ${voice.gender}    ${voice.voiced.toFixed(1)} с`,
  );
}

for (const target of targets) {
  const near = [...measured].sort((a, b) => Math.abs(a.f0 - target) - Math.abs(b.f0 - target)).slice(0, 5);
  console.log(`\nближе всего к ${target} Гц: ${near.map((v) => `${v.name} (${v.f0})`).join(', ')}`);
}
