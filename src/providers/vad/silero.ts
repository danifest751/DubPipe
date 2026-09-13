import path from 'node:path';
import { existsSync } from 'node:fs';
import { log } from '../../core/logger.js';
import { downloadFile } from '../../util/download.js';
import { streamFrames } from '../../util/wav.js';

/**
 * Speech activity detection with Silero VAD (ONNX, CPU, no Python).
 *
 * Two stages need it:
 *  - S2 snaps replica boundaries onto real speech edges, which is what brings
 *    them inside the ±250 ms tolerance (SPEC FR-2);
 *  - S7 ducks the original track inside speech windows when S4 is off (FR-4).
 */

const MODEL_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx';
const SAMPLE_RATE = 16_000;
/** Silero v5 consumes exactly 512 samples (32 ms) per step at 16 kHz. */
const FRAME_SAMPLES = 512;
/** …preceded by the last 64 samples of the previous step — see detectSpeech. */
const CONTEXT_SAMPLES = 64;

export interface SpeechRegion {
  start: number;
  end: number;
}

export interface VadOptions {
  threshold?: number;
  /** Speech shorter than this is discarded as a blip. */
  minSpeechMs?: number;
  /** Silence shorter than this does not break a region apart. */
  minSilenceMs?: number;
  /** Padding kept around each region so plosives are not clipped. */
  speechPadMs?: number;
}

export async function ensureVadModel(modelsDir: string): Promise<string> {
  const target = path.join(modelsDir, 'silero-vad.onnx');
  if (existsSync(target)) return target;
  await downloadFile(MODEL_URL, target, { label: 'silero-vad (ONNX)', minBytes: 500_000, timeoutMs: 600_000 });
  return target;
}

/**
 * Runs the detector over a 16 kHz mono WAV and returns speech regions in
 * seconds. Frames are streamed, so memory does not scale with duration.
 */
export async function detectSpeech(
  audioPath: string,
  modelsDir: string,
  options: VadOptions = {},
): Promise<SpeechRegion[]> {
  const { threshold = 0.5, minSpeechMs = 200, minSilenceMs = 150, speechPadMs = 60 } = options;

  const ort = await import('onnxruntime-node');
  const modelPath = await ensureVadModel(modelsDir);
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });

  // Silero v5 carries a single recurrent state tensor between frames.
  let state: Float32Array<ArrayBuffer> = new Float32Array(2 * 1 * 128);
  const sampleRateTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);

  /*
   * Модель рассчитана на 576 сэмплов: 64 из конца предыдущего кадра плюс 512
   * новых. Размерность входа у неё динамическая, поэтому голые 512 она молча
   * принимает — и на реальной записи видит речь в 7% кадров вместо 54%.
   * На чистом синтетическом ролике эта ошибка едва проходила незамеченной.
   */
  let context: Float32Array<ArrayBuffer> = new Float32Array(CONTEXT_SAMPLES);
  const input = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);

  const frameSeconds = FRAME_SAMPLES / SAMPLE_RATE;
  const regions: SpeechRegion[] = [];
  let speechStart: number | null = null;
  let silenceRun = 0;
  let frameIndex = 0;

  for await (const { samples } of streamFrames(audioPath, FRAME_SAMPLES)) {
    input.set(context, 0);
    input.set(samples, CONTEXT_SAMPLES);
    const feeds: Record<string, unknown> = {
      input: new ort.Tensor('float32', input, [1, input.length]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr: sampleRateTensor,
    };
    const output = await session.run(feeds as never);
    const probability = (output['output']!.data as Float32Array)[0]!;
    state = output['stateN']!.data as Float32Array<ArrayBuffer>;
    context = samples.slice(FRAME_SAMPLES - CONTEXT_SAMPLES) as Float32Array<ArrayBuffer>;

    const time = frameIndex * frameSeconds;
    if (probability >= threshold) {
      if (speechStart === null) speechStart = time;
      silenceRun = 0;
    } else if (speechStart !== null) {
      silenceRun += frameSeconds * 1000;
      if (silenceRun >= minSilenceMs) {
        const end = time - silenceRun / 1000;
        if ((end - speechStart) * 1000 >= minSpeechMs) regions.push({ start: speechStart, end });
        speechStart = null;
        silenceRun = 0;
      }
    }
    frameIndex++;
  }

  const totalSeconds = frameIndex * frameSeconds;
  if (speechStart !== null && (totalSeconds - speechStart) * 1000 >= minSpeechMs) {
    regions.push({ start: speechStart, end: totalSeconds });
  }

  await session.release?.();

  const pad = speechPadMs / 1000;
  const padded = regions.map((region) => ({
    start: Math.max(0, region.start - pad),
    end: Math.min(totalSeconds, region.end + pad),
  }));

  log.debug(`VAD: речевых участков ${padded.length} из ${frameIndex} кадров`);
  return mergeAdjacent(padded);
}

/** Padding can make neighbours touch; merge those back into one region. */
export function mergeAdjacent(regions: SpeechRegion[]): SpeechRegion[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const merged: SpeechRegion[] = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) {
      last.end = Math.max(last.end, region.end);
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/** Minimum shared time for a speech window to be considered part of a replica. */
const MIN_REGION_OVERLAP_SECONDS = 0.15;

/**
 * Snaps a replica onto real speech edges (SPEC FR-2).
 *
 * Whisper reliably overshoots the end of a replica — it stretches the final word
 * up to the start of the next one — so an end may be pulled in well beyond the
 * window, while a start is only moved when the correction is small. A window
 * that merely grazes the replica (the neighbouring replica's speech) must not be
 * treated as part of it, hence the overlap filter.
 */
export function snapToSpeech(
  segment: { start: number; end: number; words?: { start: number; end: number }[] | null },
  regions: SpeechRegion[],
  windowMs: number,
): { start: number; end: number } {
  const window = windowMs / 1000;

  const relevant = regions.filter((region) => {
    const shared = Math.min(region.end, segment.end) - Math.max(region.start, segment.start);
    if (shared <= 0) return false;
    const regionLength = region.end - region.start;
    return shared >= MIN_REGION_OVERLAP_SECONDS || shared >= regionLength * 0.5;
  });
  if (relevant.length === 0) return segment;

  const first = relevant[0]!;
  const last = relevant[relevant.length - 1]!;

  let start = segment.start;
  let end = segment.end;

  if (Math.abs(first.start - segment.start) <= window) start = first.start;

  if (Math.abs(last.end - segment.end) <= window) {
    end = last.end;
  } else if (last.end < segment.end) {
    // Speech ended well before whisper says it did; never cut into the last
    // word, so a VAD miss on quiet speech cannot truncate the replica.
    const lastWordStart = segment.words?.[segment.words.length - 1]?.start;
    end = lastWordStart === undefined ? last.end : Math.max(last.end, lastWordStart);
  }

  return end > start ? { start, end } : segment;
}
