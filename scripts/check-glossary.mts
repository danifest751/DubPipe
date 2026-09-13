/**
 * Acceptance check for SPEC M2: names must stay consistent across batches.
 *
 * Replicas are crafted so that the same three proper nouns recur in different
 * request batches (batch_size = 2), which is exactly where a session glossary
 * either works or does not.
 *
 * Usage: npx tsx scripts/check-glossary.mts
 */
import { parseConfig } from '../src/config/load.js';
import { Workspace } from '../src/core/workspace.js';
import { makeSegment } from '../src/core/types.js';
import { runS3 } from '../src/stages/s3-translate.js';

const lines: Array<[string, number]> = [
  ['Nadia, did you finish the Orchard release notes?', 2.6],
  ['Not yet. Gregory said the Orchard build is broken.', 3.2],
  ['Gregory always says that about Orchard.', 2.4],
  ['Nadia, can you check with Gregory before lunch?', 2.9],
  ['Fine. But Orchard is his project, not mine.', 2.7],
  ['Tell Nadia the Orchard deadline moved to Friday.', 2.8],
];

let cursor = 0.5;
const segments = lines.map(([text, slot], id) => {
  const start = cursor;
  cursor += slot + 0.5;
  return makeSegment({ id, start, end: start + slot, text_en: text });
});

const config = parseConfig({ translate: { batch_size: 2 } }, 'проверка глоссария');
const workspace = await Workspace.open('glossary-consistency-check', config);
await workspace.writeSegments(segments);

const result = await runS3(workspace, config, segments);

console.log('');
console.log(`провайдер: ${result.provider}`);
console.log(`глоссарий сессии: ${JSON.stringify(result.glossary)}`);
console.log('');
for (const segment of result.segments) console.log(`  ${segment.id}: ${segment.text_ru}`);

const checks = [
  { en: 'Nadia', ids: [0, 3, 5] },
  { en: 'Gregory', ids: [1, 2, 3] },
  { en: 'Orchard', ids: [0, 1, 2, 4, 5] },
];

// The failure mode worth catching is mixing scripts for one name between
// batches, so the check looks at script choice rather than exact word forms.
console.log('');
console.log('консистентность между пакетами:');
let allOk = true;
for (const { en, ids } of checks) {
  const latin = ids.filter((id) => (result.segments[id]!.text_ru ?? '').includes(en));
  const cyrillic = ids.filter((id) => !(result.segments[id]!.text_ru ?? '').includes(en));
  const consistent = latin.length === 0 || cyrillic.length === 0;
  allOk &&= consistent;
  console.log(
    `  ${consistent ? '✓' : '✗'} ${en}: латиницей в [${latin.join(', ') || '—'}], ` +
      `кириллицей в [${cyrillic.join(', ') || '—'}]`,
  );
}

console.log('');
console.log(allOk ? 'Критерий M2 (консистентность) выполнен' : 'Критерий M2 (консистентность) НЕ выполнен');
await workspace.clear();
process.exit(allOk ? 0 : 1);
