/**
 * Живая проверка движка: обе модели silero поднимаются в одном мосту.
 *
 * Дикторы лежат в двух моделях, и каждая подгружается по требованию — по имени
 * голоса. Сборка и тесты этого не проверяют: там нет ни Python, ни моделей на
 * диске. Здесь берётся настоящий движок, настоящий рабочий каталог и настоящий
 * Python, иначе «работает» означало бы только «собирается».
 *
 * Использование: npx tsx scripts/check-native-voices.mts [каталог для проб]
 */
import path from 'node:path';
import { statSync } from 'node:fs';
import { parseConfig } from '../src/config/load.js';
import { Workspace } from '../src/core/workspace.js';
import { createTtsProvider } from '../src/providers/tts/index.js';

const out = path.resolve(process.argv[2] ?? '.');
const config = parseConfig({ tts: { engine: 'silero', default_voice: 'ru_xenia' } }, 'проба');
const workspace = await Workspace.open(path.resolve('package.json'), config);
const provider = createTtsProvider(workspace, config);
console.log('движок:', provider.name);
console.log('отпечаток:', provider.fingerprint);

// Носитель и диктор с акцентом подряд: так видно, что в одном процессе
// поднимаются обе модели, а не одна.
const lines: Array<[number, string, string]> = [
  [1, 'ru_baya', 'Он ушёл на рассвете, никого не предупредив.'],
  [2, 'ru_ekaterina', 'Он ушёл на рассвете, никого не предупредив.'],
  [3, 'ru_eugene', 'Завтра они подойдут к воротам, и мы встретим их там.'],
];

for (const [id, voice, text] of lines) {
  const started = Date.now();
  const result = await provider.synthesize({ id, text, voice, outputPath: path.join(out, `engine-${voice}.wav`) });
  const kb = (statSync(result.path).size / 1024).toFixed(0);
  const spent = ((Date.now() - started) / 1000).toFixed(2);
  console.log(`${voice.padEnd(14)} ${result.durationSeconds.toFixed(2)} с звука, ${kb} КБ, за ${spent} с`);
}

try {
  await provider.synthesize({ id: 4, text: 'нет такого', voice: 'ru_RU-denis-medium', outputPath: path.join(out, 'no.wav') });
  console.log('ОШИБКА: чужой голос прошёл');
} catch (error) {
  console.log('чужой голос отвергнут:', (error as Error).message.slice(0, 90));
}

provider.close?.();
