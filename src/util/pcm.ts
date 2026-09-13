import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { readWavFormat } from './wav.js';

/**
 * Building the dubbed audio tracks directly, sample by sample.
 *
 * The alternative — one ffmpeg filter graph with an input per replica — breaks
 * down on real material: hundreds of inputs hit filter and command-line limits.
 * Writing PCM here keeps memory flat, has no length limits, and makes the two
 * tracks (voice, ducking envelope) exactly what the spec describes.
 */

const BYTES_PER_SAMPLE = 2;
const SILENCE_CHUNK_SAMPLES = 48_000;

export interface TrackClip {
  path: string;
  startSeconds: number;
}

function writeWavHeader(
  stream: Writable,
  options: { sampleRate: number; channels: number; dataLength: number },
): void {
  const { sampleRate, channels, dataLength } = options;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  stream.write(header);
}

function write(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function writeSilence(stream: Writable, samples: number, channels: number): Promise<void> {
  let remaining = samples;
  const chunk = Buffer.alloc(SILENCE_CHUNK_SAMPLES * channels * BYTES_PER_SAMPLE);
  while (remaining > 0) {
    const take = Math.min(remaining, SILENCE_CHUNK_SAMPLES);
    await write(stream, take === SILENCE_CHUNK_SAMPLES ? chunk : chunk.subarray(0, take * channels * BYTES_PER_SAMPLE));
    remaining -= take;
  }
}

/** Copies a clip's PCM payload, returning how many frames were written. */
async function appendClip(stream: Writable, clipPath: string): Promise<number> {
  const format = await readWavFormat(clipPath);
  const source = createReadStream(clipPath, {
    start: format.dataOffset,
    end: format.dataOffset + format.dataLength - 1,
  });
  for await (const chunk of source) {
    await write(stream, chunk as Buffer);
  }
  return format.dataLength / (BYTES_PER_SAMPLE * format.channels);
}

function finish(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.end(() => resolve());
  });
}

export interface VoiceTrackResult {
  path: string;
  durationSeconds: number;
  /** Clips that had to be pushed right because the previous one still played. */
  collisions: number;
}

/**
 * Lays synthesised clips onto a silent track at their timecodes (SPEC FR-7).
 * Clips are expected not to overlap after S6; if one still does, it is pushed
 * to the right rather than mixed on top of its neighbour.
 */
export async function buildVoiceTrack(
  clips: TrackClip[],
  totalSeconds: number,
  sampleRate: number,
  outputPath: string,
): Promise<VoiceTrackResult> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const stream = createWriteStream(outputPath);
  // Length is patched after writing, so a placeholder header goes first.
  writeWavHeader(stream, { sampleRate, channels: 1, dataLength: 0 });

  const ordered = [...clips].sort((a, b) => a.startSeconds - b.startSeconds);
  let written = 0;
  let collisions = 0;

  for (const clip of ordered) {
    const target = Math.round(clip.startSeconds * sampleRate);
    if (target > written) {
      await writeSilence(stream, target - written, 1);
      written = target;
    } else if (target < written) {
      collisions++;
    }
    written += await appendClip(stream, clip.path);
  }

  const totalSamples = Math.round(totalSeconds * sampleRate);
  if (written < totalSamples) {
    await writeSilence(stream, totalSamples - written, 1);
    written = totalSamples;
  }

  await finish(stream);
  await patchWavLength(outputPath, written * BYTES_PER_SAMPLE);

  return { path: outputPath, durationSeconds: written / sampleRate, collisions };
}

/** Rewrites the two size fields once the payload length is known. */
async function patchWavLength(filePath: string, dataLength: number): Promise<void> {
  const { open } = await import('node:fs/promises');
  const handle = await open(filePath, 'r+');
  try {
    const riff = Buffer.alloc(4);
    riff.writeUInt32LE(36 + dataLength, 0);
    await handle.write(riff, 0, 4, 4);
    const data = Buffer.alloc(4);
    data.writeUInt32LE(dataLength, 0);
    await handle.write(data, 0, 4, 40);
  } finally {
    await handle.close();
  }
}

export interface SpeechWindow {
  start: number;
  end: number;
}

export interface EnvelopeOptions {
  duckDb: number;
  fadeMs: number;
  channels: number;
}

/**
 * Gain envelope for ducking the original inside speech windows (SPEC FR-4).
 *
 * Produced as an audio file and applied with ffmpeg's `amultiply`: an exact
 * curve with real fades, and none of the expression-length limits that a
 * `volume=...:enable=between(...)` chain would hit on hundreds of windows.
 */
export function envelopeValueAt(
  timeSeconds: number,
  windows: SpeechWindow[],
  duckGain: number,
  fadeSeconds: number,
): number {
  for (const window of windows) {
    if (timeSeconds < window.start - fadeSeconds || timeSeconds > window.end + fadeSeconds) continue;

    if (timeSeconds < window.start) {
      const progress = (timeSeconds - (window.start - fadeSeconds)) / fadeSeconds;
      return 1 - (1 - duckGain) * progress;
    }
    if (timeSeconds > window.end) {
      const progress = (timeSeconds - window.end) / fadeSeconds;
      return duckGain + (1 - duckGain) * progress;
    }
    return duckGain;
  }
  return 1;
}

export async function buildDuckEnvelope(
  windows: SpeechWindow[],
  totalSeconds: number,
  sampleRate: number,
  options: EnvelopeOptions,
  outputPath: string,
): Promise<string> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const stream = createWriteStream(outputPath);
  const totalSamples = Math.round(totalSeconds * sampleRate);
  const { channels } = options;
  writeWavHeader(stream, { sampleRate, channels, dataLength: totalSamples * channels * BYTES_PER_SAMPLE });

  const duckGain = 10 ** (options.duckDb / 20);
  const fadeSeconds = Math.max(options.fadeMs / 1000, 1 / sampleRate);
  const sorted = [...windows].sort((a, b) => a.start - b.start);

  const chunkSamples = 48_000;
  const chunk = Buffer.alloc(chunkSamples * channels * BYTES_PER_SAMPLE);
  let cursor = 0;
  let windowIndex = 0;

  while (cursor < totalSamples) {
    const take = Math.min(chunkSamples, totalSamples - cursor);
    for (let i = 0; i < take; i++) {
      const time = (cursor + i) / sampleRate;
      // Windows are sorted, so the search only ever moves forward.
      while (windowIndex < sorted.length && time > sorted[windowIndex]!.end + fadeSeconds) windowIndex++;
      const value = envelopeValueAt(time, sorted.slice(windowIndex, windowIndex + 2), duckGain, fadeSeconds);
      const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
      for (let channel = 0; channel < channels; channel++) {
        chunk.writeInt16LE(sample, (i * channels + channel) * BYTES_PER_SAMPLE);
      }
    }
    await write(stream, chunk.subarray(0, take * channels * BYTES_PER_SAMPLE));
    cursor += take;
  }

  await finish(stream);
  return outputPath;
}
