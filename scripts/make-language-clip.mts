/**
 * Собирает короткий тестовый ролик на выбранном языке: речь синтезируется
 * локально голосом piper, поэтому материал свой и его можно гонять через
 * конвейер сколько угодно.
 *
 * Нужен, чтобы проверять работу с языком оригинала, отличным от английского:
 * распознавание, перевод под длительность, субтитры по нормам письменности.
 *
 * Запуск:
 *   npx tsx scripts/make-language-clip.mts ko
 *   npx tsx scripts/make-language-clip.mts ko --out D:\\clips\\korean.mp4
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { Workspace } from '../src/core/workspace.js';
import { languageProfile } from '../src/core/languages.js';
import { ensureVoice } from '../src/providers/tts/voices.js';
import { requireTool } from '../src/util/tools.js';

/** Свои бытовые фразы: короткие, с вопросом и ответом, без чужого текста. */
const SCRIPTS: Record<string, { voice: string; lines: string[] }> = {
  ko: {
    voice: 'ko_KR-kss-medium',
    lines: [
      '안녕하세요. 오늘 회의는 몇 시에 시작해요?',
      '세 시예요. 자료는 이미 보냈어요.',
      '고마워요. 회의실은 어디예요?',
      '이 층 끝에 있어요. 곧 만나요.',
    ],
  },
  de: {
    voice: 'de_DE-thorsten-medium',
    lines: [
      'Guten Morgen. Wann beginnt die Besprechung heute?',
      'Um drei. Die Unterlagen habe ich schon geschickt.',
      'Danke. Wo ist der Besprechungsraum?',
      'Am Ende des zweiten Stocks. Bis gleich.',
    ],
  },
};

const LEAD_IN = 0.6;
const GAP = 0.5;

const code = (process.argv[2] ?? 'ko').toLowerCase();
const script = SCRIPTS[code];
if (!script) {
  console.error(`Нет заготовки для языка «${code}». Доступны: ${Object.keys(SCRIPTS).join(', ')}`);
  process.exit(2);
}

const outIndex = process.argv.indexOf('--out');
const { config } = await loadConfig();
const workspace = await Workspace.open('language-clip', config);
const work = path.join(workspace.root, 'samples', code);
mkdirSync(work, { recursive: true });
const output = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]!) : path.join(work, `sample-${code}.mp4`);

const ffmpeg = await requireTool('ffmpeg', workspace.toolsDir);
const ffprobe = await requireTool('ffprobe', workspace.toolsDir);
const piper = await requireTool('piper', workspace.toolsDir);
const voice = await ensureVoice(script.voice, workspace.modelsDir);

const sh = (file: string, args: string[], input?: string) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input ? { input } : {}) });

const durationOf = (file: string) =>
  Number(sh(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());

console.log(`Язык: ${languageProfile(code).name}, голос: ${script.voice}`);

const placed: Array<{ file: string; start: number; end: number; text: string }> = [];
let cursor = LEAD_IN;
for (const [index, text] of script.lines.entries()) {
  const wav = path.join(work, `line${index}.wav`);
  sh(piper, ['-m', voice.modelPath, '-c', voice.configPath, '-f', wav, '--sentence_silence', '0', '-q'], text);
  const duration = durationOf(wav);
  placed.push({ file: wav, start: Number(cursor.toFixed(3)), end: Number((cursor + duration).toFixed(3)), text });
  console.log(`  ${cursor.toFixed(2)}–${(cursor + duration).toFixed(2)} с  ${text}`);
  cursor += duration + GAP;
}

const total = Math.ceil(cursor + 0.4);

// Тихий фон: конвейеру есть что сохранить при сведении.
const music = path.join(work, 'background.wav');
sh(ffmpeg, [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', `sine=frequency=220:duration=${total}`,
  '-f', 'lavfi', '-i', `sine=frequency=330:duration=${total}`,
  '-filter_complex', '[0][1]amix=inputs=2:duration=longest,volume=0.06,aresample=48000',
  '-ac', '2', music,
]);

const inputs = ['-i', music];
for (const line of placed) inputs.push('-i', line.file);
const filters = placed
  .map((line, index) => `[${index + 1}:a]aresample=48000,adelay=${Math.round(line.start * 1000)}|${Math.round(line.start * 1000)},volume=1.6[s${index}]`)
  .join(';');
const mixInputs = ['[0:a]', ...placed.map((_, index) => `[s${index}]`)].join('');
const mixed = path.join(work, 'mixed.wav');
sh(ffmpeg, [
  '-y', '-v', 'error', ...inputs,
  '-filter_complex', `${filters};${mixInputs}amix=inputs=${placed.length + 1}:duration=first:normalize=0[out]`,
  '-map', '[out]', '-ac', '2', '-ar', '48000', '-t', String(total), mixed,
]);

sh(ffmpeg, [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', `color=c=0x202830:s=640x360:d=${total}:r=25`,
  '-i', mixed,
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', output,
]);

if (!existsSync(output)) {
  console.error('Ролик не собрался');
  process.exit(1);
}
console.log(`\nГотово: ${output} (${total} с, реплик ${placed.length})`);
console.log(`Прогон: npx tsx src/cli.ts process "${output}"  — при asr.language: ${code}`);
