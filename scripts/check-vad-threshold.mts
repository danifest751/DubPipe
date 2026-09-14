/**
 * Подбор порога VAD на реальном материале: вероятности речи по кадрам
 * сравниваются с репликами (segments.json). Для каждого порога — доля реплик
 * без речи по VAD, покрытие слотов и ложная речь вне реплик.
 *
 * Запуск: npx tsx scripts/check-vad-threshold.mts <рабочий каталог видео>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { streamFrames } from '../src/util/wav.js';

const ws = process.argv[2];
if (!ws) { console.error('нужен рабочий каталог'); process.exit(2); }
const segments = JSON.parse(await readFile(path.join(ws, 'segments.json'), 'utf8')) as Array<{ start: number; end: number }>;
const ort = await import('onnxruntime-node');
const modelPath = path.join(ws, '..', 'models', 'silero-vad.onnx');
const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
const FRAME = 512, CONTEXT = 64, SR = 16000;
// onnxruntime отдаёт буфер с более широким типом, чем у литерала.
let state: Float32Array<ArrayBufferLike> = new Float32Array(2 * 128);
let context = new Float32Array(CONTEXT);
const input = new Float32Array(CONTEXT + FRAME);
const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SR)]), [1]);
const probs: number[] = [];
for await (const { samples } of streamFrames(path.join(ws, 'audio16k.wav'), FRAME)) {
  input.set(context, 0); input.set(samples, CONTEXT);
  const out = await session.run({ input: new ort.Tensor('float32', input, [1, input.length]), state: new ort.Tensor('float32', state, [2, 1, 128]), sr });
  probs.push((out['output']!.data as Float32Array)[0]!);
  state = out['stateN']!.data as Float32Array;
  context = samples.slice(FRAME - CONTEXT);
}
const step = FRAME / SR;
const inside = new Uint8Array(probs.length);
for (const s of segments) for (let i = Math.floor(s.start / step); i < Math.min(probs.length, Math.ceil(s.end / step)); i++) inside[i] = 1;
console.log('кадров:', probs.length, 'реплик:', segments.length);
for (const thr of [0.5, 0.4, 0.3, 0.25, 0.2, 0.15]) {
  let zero = 0; const cover: number[] = []; const onsetGap: number[] = [];
  for (const s of segments) {
    const a = Math.floor(s.start / step), b = Math.min(probs.length, Math.ceil(s.end / step));
    let hit = 0; let first = -1;
    for (let i = a; i < b; i++) if (probs[i]! >= thr) { hit++; if (first < 0) first = i; }
    if (hit === 0) zero++; else { cover.push(hit / (b - a)); onsetGap.push(first * step - s.start); }
  }
  let falseFrames = 0, outsideFrames = 0;
  for (let i = 0; i < probs.length; i++) if (!inside[i]) { outsideFrames++; if (probs[i]! >= thr) falseFrames++; }
  const med = (arr: number[]) => arr.length ? [...arr].sort((x, y) => x - y)[Math.floor(arr.length / 2)]! : 0;
  console.log('порог ' + thr + ': реплик без речи ' + zero + ', покрытие медиана ' + med(cover).toFixed(2) + ', начало речи позже start на медиана ' + med(onsetGap).toFixed(2) + ' с, ложная речь вне реплик ' + (falseFrames * step).toFixed(1) + ' с из ' + (outsideFrames * step).toFixed(0));
}
