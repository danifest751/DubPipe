/**
 * Чистит уже распознанные реплики от галлюцинаций whisper, не перезапуская
 * распознавание: те же правила, что и в стадии S2, применяются к segments.json
 * рабочего каталога.
 *
 * Нужен для файлов, распознанных до появления фильтра: перераспознавание
 * тридцатиминутного эпизода стоит получаса, а чистка — доли секунды.
 *
 * Запуск: npx tsx scripts/clean-hallucinations.mts <видео или рабочий каталог> [--apply]
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { Workspace } from '../src/core/workspace.js';
import { collapseRepeats, isHallucination, trimLoopedText } from '../src/stages/s2-segments.js';
import type { Segment } from '../src/core/types.js';

const target = process.argv[2];
if (!target) {
  console.error('нужен путь к видео или к рабочему каталогу (.dubpipe/<hash>)');
  process.exit(2);
}
const apply = process.argv.includes('--apply');
const configIndex = process.argv.indexOf('--config');

// Принимаем и видео, и рабочий каталог: своё имя файла человек знает, а каталог
// назван хешем, который наизусть не помнит никто.
const directory = existsSync(path.join(target, 'segments.json'))
  ? target
  : (await Workspace.open(target, (await loadConfig(configIndex > 0 ? process.argv[configIndex + 1] : undefined)).config))
      .dir;
const file = path.join(directory, 'segments.json');
if (!existsSync(file)) {
  console.error(`в ${directory} нет segments.json: сначала нужно распознавание`);
  process.exit(2);
}
const segments = JSON.parse(await readFile(file, 'utf8')) as Segment[];

// Те же шаги, что и в стадии: зацикленный текст, залипания, служебные формулы.
const trimmed = segments.map((segment) => ({ ...segment, text: trimLoopedText(segment.text_en) }));
const collapsed = collapseRepeats(trimmed);
const kept = collapsed.filter((segment) => !isHallucination(segment.text));

const keptIds = new Set(kept.map((segment) => segment.id));
const removed = segments.filter((segment) => !keptIds.has(segment.id));
const result = segments
  .filter((segment) => keptIds.has(segment.id))
  .map((segment) => {
    const cleaned = kept.find((item) => item.id === segment.id)!;
    return cleaned.text === segment.text_en ? segment : { ...segment, text_en: cleaned.text };
  });

console.log(`реплик было: ${segments.length}, останется: ${result.length}, удалено: ${removed.length}`);
const byText = new Map<string, number>();
for (const segment of removed) byText.set(segment.text_en.trim(), (byText.get(segment.text_en.trim()) ?? 0) + 1);
console.log('\nчто удалено:');
for (const [text, count] of [...byText.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(count).padStart(3)}×  ${text.slice(0, 60)}`);
}

if (!apply) {
  console.log('\nЭто предварительный просмотр. Повторите с --apply, чтобы записать.');
  process.exit(0);
}

await writeFile(`${file}.before-clean`, JSON.stringify(segments, null, 1), 'utf8');
await writeFile(file, JSON.stringify(result, null, 1), 'utf8');
console.log(`\nЗаписано. Прежний файл сохранён рядом: ${path.basename(file)}.before-clean`);
console.log('Дальше: прогон со стадии подгонки пересоберёт дубляж без этих реплик.');
