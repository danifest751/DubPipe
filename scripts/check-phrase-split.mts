/**
 * На какие куски разрезается реплика по паузам оригинала.
 *
 * Использование: npx tsx scripts/check-phrase-split.mts <segments.json> [id ...]
 */
import { readFile } from 'node:fs/promises';
import { sourcePhrases, splitTranslation } from '../src/stages/s5-phrases.js';
import type { Segment } from '../src/core/types.js';

const file = process.argv[2];
if (!file) {
  console.error('укажите segments.json');
  process.exit(2);
}
const wanted = process.argv.slice(3).map(Number);
const parsed = JSON.parse(await readFile(file, 'utf8')) as { segments?: Segment[] } | Segment[];
const segments = Array.isArray(parsed) ? parsed : (parsed.segments ?? []);

for (const segment of segments) {
  if (wanted.length > 0 && !wanted.includes(segment.id)) continue;
  const phrases = sourcePhrases(segment.words ?? null);
  const plan = segment.text_ru ? splitTranslation(segment.text_ru, phrases) : null;
  if (plan === null) continue;
  console.log(`реплика ${segment.id}: пауз ${phrases.length - 1}, кусков ${plan.parts.length}`);
  plan.parts.forEach((part, index) => {
    const speakable = /[а-яёА-ЯЁ]/.test(part);
    console.log(`  part${index}: ${speakable ? ' ' : '!'} ${JSON.stringify(part)}`);
  });
}
