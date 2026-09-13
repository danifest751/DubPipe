/**
 * Проверка готовых файлов субтитров: формат, порядок, наложения, длина строк
 * и скорость чтения. Печатает сводку и примеры проблемных титров.
 *
 * Запуск: npx tsx scripts/check-subtitles.mts "<путь к .srt>" [ещё файлы…]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cueProblems, parseSrt, DEFAULT_SUBTITLE_OPTIONS } from '../src/stages/subtitles.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('нужен хотя бы один файл .srt');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const cues = parseSrt(text);
  const counts = new Map<string, number>();
  for (const [index, cue] of cues.entries()) {
    for (const problem of cueProblems(cue, cues[index + 1], DEFAULT_SUBTITLE_OPTIONS)) {
      counts.set(problem, (counts.get(problem) ?? 0) + 1);
    }
  }
  const lines = cues.flatMap((cue) => cue.lines);
  const longest = Math.max(0, ...lines.map((line) => line.length));
  const maxLines = Math.max(0, ...cues.map((cue) => cue.lines.length));
  const ordered = cues.every((cue, index) => index === 0 || cue.start >= cues[index - 1]!.start);
  const bom = text.charCodeAt(0) === 0xfeff;
  const overlap = counts.get('overlap') ?? 0;

  console.log(`\n${path.basename(file)}`);
  console.log(`  титров: ${cues.length}; строк: ${lines.length}; BOM: ${bom}; порядок по времени: ${ordered}`);
  console.log(`  самая длинная строка: ${longest} симв (норма ${DEFAULT_SUBTITLE_OPTIONS.maxLineChars}); строк в титре максимум: ${maxLines}`);
  console.log(`  замечания: ${counts.size === 0 ? 'нет' : [...counts].map(([key, value]) => `${key}=${value}`).join(', ')}`);
  const sample = cues.find((cue, index) => cueProblems(cue, cues[index + 1], DEFAULT_SUBTITLE_OPTIONS).length > 0);
  if (sample) console.log(`  пример: ${sample.start.toFixed(2)}–${sample.end.toFixed(2)} «${sample.lines.join(' / ')}»`);
  console.log(`  первый титр: ${cues[0]?.start.toFixed(2)}–${cues[0]?.end.toFixed(2)} «${cues[0]?.lines.join(' / ')}»`);

  if (cues.length === 0 || !ordered || overlap > 0 || longest > DEFAULT_SUBTITLE_OPTIONS.maxLineChars || maxLines > DEFAULT_SUBTITLE_OPTIONS.maxLines) failed = true;
}

console.log(failed ? '\nПРОВЕРКА НЕ ПРОЙДЕНА' : '\nПРОВЕРКА ПРОЙДЕНА');
process.exit(failed ? 1 : 0);
