import { run } from './exec.js';
import { requireTool } from './tools.js';

/** ffmpeg/ffprobe helpers shared by S1, S5, S6 and S7. */

export interface MediaInfo {
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels: number;
  audioSampleRate: number;
}

interface FfprobeStream {
  codec_type?: string;
  channels?: number;
  sample_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export async function probeMedia(filePath: string, toolsDir: string): Promise<MediaInfo> {
  const ffprobe = await requireTool('ffprobe', toolsDir);
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: 120_000 },
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const audio = streams.find((s) => s.codec_type === 'audio');

  return {
    durationSeconds: Number(parsed.format?.duration ?? 0),
    hasVideo: streams.some((s) => s.codec_type === 'video'),
    hasAudio: audio !== undefined,
    audioChannels: audio?.channels ?? 0,
    audioSampleRate: Number(audio?.sample_rate ?? 0),
  };
}

/** Analysis track: WAV, 48 kHz, mono, 16-bit (SPEC FR-1). */
export async function extractAnalysisAudio(input: string, output: string, toolsDir: string): Promise<void> {
  const ffmpeg = await requireTool('ffmpeg', toolsDir);
  await run(
    ffmpeg,
    ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', '-f', 'wav', output],
    { timeoutMs: 3_600_000 },
  );
}

/** Mixing copy: keeps the original channel layout (SPEC FR-1, revised). */
export async function extractOriginalAudio(input: string, output: string, toolsDir: string): Promise<void> {
  const ffmpeg = await requireTool('ffmpeg', toolsDir);
  await run(ffmpeg, ['-y', '-i', input, '-vn', '-ar', '48000', '-acodec', 'pcm_s16le', '-f', 'wav', output], {
    timeoutMs: 3_600_000,
  });
}

/** 16 kHz mono PCM — the only input format whisper.cpp accepts. */
export async function toWhisperAudio(input: string, output: string, toolsDir: string): Promise<void> {
  const ffmpeg = await requireTool('ffmpeg', toolsDir);
  await run(
    ffmpeg,
    ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', output],
    { timeoutMs: 3_600_000 },
  );
}

/**
 * ffmpeg's atempo filter only accepts 0.5–2.0 per instance, so wider factors are
 * expressed as a chain. Pure function: unit-tested without ffmpeg present.
 */
export function buildAtempoChain(tempo: number): string[] {
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error(`Недопустимый темп: ${tempo}`);
  if (Math.abs(tempo - 1) < 1e-6) return [];

  const factors: number[] = [];
  let remaining = tempo;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);
  return factors.map((f) => `atempo=${f.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`);
}

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}
