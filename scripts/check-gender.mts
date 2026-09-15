/**
 * Пол голосов спикеров по готовой диаризации рабочего каталога: печатает
 * медиану основного тона и вердикт для каждого спикера, а при наличии
 * segments.json — ещё и реплики, чей собственный тон спорит с говорящим.
 *
 * Запуск: npx tsx scripts/check-gender.mts <рабочий каталог видео> [--write]  (--write обновляет speakers.json)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  disputedSpans,
  effectiveGender,
  genderDisputed,
  profileSpan,
  profileSpeech,
  DISPUTE_MIN_VOICED_SECONDS,
} from '../src/providers/diarization/gender.js';
import { speakerGenderByText } from '../src/core/text-gender.js';
import type { Segment } from '../src/core/types.js';
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
const { speakers: profiles, samples, secondsPerFrame } = await profileSpeech(path.join(ws, 'audio16k.wav'), intervals);
for (const [speaker, profile] of [...profiles].sort()) console.log(speaker, JSON.stringify(profile));

// Спорные реплики — то же, что конвейер помечает флагом speaker_doubt. Заодно
// видно, скольким репликам вообще хватило звонкой речи на собственный замер:
// без этого «спорных нет» не отличить от «мерить было не на чем».
const segments: Segment[] = await readFile(path.join(ws, 'segments.json'), 'utf8')
  .then((raw) => JSON.parse(raw) as Segment[])
  .catch(() => []);
if (segments.length > 0) {
  // Вторая улика о поле — род в русском переводе. Тон молчит чаще, чем кажется,
  // а текст называет род прямо; переводчику пол не сообщают, так что улика своя.
  const byText = speakerGenderByText(segments);
  for (const [speaker, verdict] of Object.entries(byText)) {
    const profile = profiles.get(speaker);
    const merged = { ...(profile ?? { gender: '—' as const, f0: null, voicedSeconds: 0 }), text: verdict };
    const mark = genderDisputed(merged) ? 'СПОР' : profile?.gender === '—' && verdict.gender !== '—' ? 'решает текст' : '';
    console.log(
      `${speaker}: по тону ${profile?.gender ?? '—'}, по тексту ${verdict.gender} ` +
        `(о себе ${verdict.self}, обращений ${verdict.address}) -> ${effectiveGender(merged)} ${mark}` +
        (verdict.examples.length > 0 ? `
    ${verdict.examples.join(', ')}` : ''),
    );
  }

  const measurable = segments.filter(
    (segment) => profileSpan(segment, samples.get(segment.speaker), secondsPerFrame).voicedSeconds >= DISPUTE_MIN_VOICED_SECONDS,
  ).length;
  const disputed = disputedSpans(segments, profiles, samples, secondsPerFrame);
  console.log(`реплик: ${segments.length}, со своим замером (>=${DISPUTE_MIN_VOICED_SECONDS} с звонких): ${measurable}, спорных: ${disputed.size}`);
  for (const [id, line] of disputed) {
    const speaker = segments.find((segment) => segment.id === id)!.speaker;
    console.log(`  id=${id}: ${line.f0} Гц (звонких ${line.voicedSeconds} с) при ${profiles.get(speaker)?.f0} Гц у ${speaker} (${profiles.get(speaker)?.gender})`);
  }
}
if (process.argv.includes('--write')) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(ws, 'speakers.json'), JSON.stringify(Object.fromEntries(profiles), null, 2), 'utf8');
  console.log('speakers.json перезаписан');
}
console.log(`время: ${Date.now() - started} мс`);
