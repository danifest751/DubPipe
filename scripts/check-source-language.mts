/**
 * Проверка перевода с выбранного языка оригинала: реплики уходят в модель
 * с профилем этого языка, и видно, не режет ли предел длины перевод.
 *
 * Запуск: npx tsx scripts/check-source-language.mts ko
 */
import { loadConfig } from '../src/config/load.js';
import { languageProfile } from '../src/core/languages.js';
import { makeSegment } from '../src/core/types.js';
import { boundedTargetChars, targetChars, translateSegments } from '../src/stages/s3-translate.js';
import { KiloGatewayClient } from '../src/providers/llm/index.js';

const SAMPLES: Record<string, Array<{ text: string; seconds: number }>> = {
  ko: [
    { text: '안녕하세요. 오늘 회의는 몇 시에 시작해요?', seconds: 2.6 },
    { text: '세 시예요. 자료는 이미 보냈어요.', seconds: 2.2 },
    { text: '고마워요. 회의실은 어디예요?', seconds: 1.9 },
    { text: '이 층 끝에 있어요. 곧 만나요.', seconds: 2.1 },
  ],
  zh: [
    { text: '你好，今天的会议几点开始？', seconds: 2.4 },
    { text: '三点。资料我已经发过去了。', seconds: 2.3 },
  ],
  en: [
    { text: 'Hello. What time does the meeting start today?', seconds: 2.6 },
    { text: 'At three. I have already sent the materials.', seconds: 2.2 },
  ],
};

const code = (process.argv[2] ?? 'ko').toLowerCase();
const samples = SAMPLES[code];
if (!samples) {
  console.error(`Нет образцов для «${code}». Доступны: ${Object.keys(SAMPLES).join(', ')}`);
  process.exit(2);
}

const { config } = await loadConfig();
const profile = languageProfile(code);
const runConfig = { ...config, asr: { ...config.asr, language: code } };
const cps = config.translate.chars_per_second;

console.log(`Язык оригинала: ${profile.name} (${profile.code}), предел длины ×${profile.expansionCap}\n`);
console.log('Цель по длине для каждой реплики:');
for (const sample of samples) {
  const bySlot = targetChars(sample.seconds, cps);
  const bounded = boundedTargetChars(sample.text, sample.seconds, cps, profile.expansionCap);
  const latin = boundedTargetChars(sample.text, sample.seconds, cps, languageProfile('en').expansionCap);
  console.log(`  «${sample.text}» (${sample.text.length} симв, слот ${sample.seconds} с)`);
  console.log(`     по слоту ${bySlot}, с профилем ${code}: ${bounded}, с латинским правилом было бы: ${latin}`);
}

const client = await KiloGatewayClient.create(runConfig);
if (!client) {
  console.log('\nКлюч шлюза не задан — перевод не проверяем.');
  process.exit(0);
}

const segments = samples.map((sample, index) =>
  makeSegment({ id: index, start: index * 4, end: index * 4 + sample.seconds, text_en: sample.text }),
);

console.log(`\nПеревожу через ${client.name} / ${client.model}…`);
const run = await translateSegments(client, runConfig, segments);
console.log(`Запросов: ${run.usage.requests}, стоимость: $${(run.usage.cost ?? 0).toFixed(4)}\n`);

let ok = true;
for (const segment of run.segments) {
  const slot = segment.end - segment.start;
  const translated = segment.text_ru ?? '';
  const estimated = translated.length / cps;
  const fits = Math.abs(estimated - slot) <= Math.max(slot * 0.15, 0.25);
  if (!translated.trim()) ok = false;
  console.log(`  ${segment.text_en}`);
  console.log(`  → ${translated}  (${translated.length} симв, ${estimated.toFixed(2)} с при слоте ${slot.toFixed(2)} с${fits ? '' : ', вне допуска'})`);
}

console.log(ok ? '\nПРОВЕРКА ПРОЙДЕНА' : '\nПРОВЕРКА НЕ ПРОЙДЕНА');
process.exit(ok ? 0 : 1);
