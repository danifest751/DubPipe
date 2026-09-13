import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Minimal WAV reading for 16-bit PCM. Audio is consumed in chunks and never
 * held in memory whole, so hour-long inputs stay within budget (SPEC §7).
 */

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

/** Reads the RIFF header and locates the data chunk. */
export async function readWavFormat(filePath: string): Promise<WavFormat> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`Файл не является WAV: ${filePath}`);
    }

    let offset = 12;
    let format: Partial<WavFormat> = {};
    while (offset + 8 <= bytesRead) {
      const id = header.toString('ascii', offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        format = {
          ...format,
          channels: header.readUInt16LE(offset + 10),
          sampleRate: header.readUInt32LE(offset + 12),
          bitsPerSample: header.readUInt16LE(offset + 22),
        };
      } else if (id === 'data') {
        return {
          sampleRate: format.sampleRate ?? 0,
          channels: format.channels ?? 1,
          bitsPerSample: format.bitsPerSample ?? 16,
          dataOffset: offset + 8,
          dataLength: size,
        };
      }
      offset += 8 + size + (size % 2);
    }
    throw new Error(`В WAV не найден блок data: ${filePath}`);
  } finally {
    await handle.close();
  }
}

/**
 * Streams mono float samples in fixed-size frames. Stereo input is downmixed.
 * The final frame is zero-padded so the consumer always sees frameSize samples.
 */
export async function* streamFrames(
  filePath: string,
  frameSize: number,
): AsyncGenerator<{ samples: Float32Array; index: number }> {
  const format = await readWavFormat(filePath);
  if (format.bitsPerSample !== 16) {
    throw new Error(`Поддерживается только 16-битный PCM, получено ${format.bitsPerSample} бит`);
  }

  const bytesPerSample = 2;
  const stream = createReadStream(filePath, {
    start: format.dataOffset,
    end: format.dataOffset + format.dataLength - 1,
  });

  let carry: Buffer<ArrayBuffer> = Buffer.alloc(0);
  let frame = new Float32Array(frameSize);
  let filled = 0;
  let index = 0;

  for await (const chunk of stream) {
    let buffer: Buffer<ArrayBuffer> = carry.length
      ? Buffer.concat([carry, chunk as Buffer])
      : (chunk as Buffer<ArrayBuffer>);
    const frameBytes = bytesPerSample * format.channels;
    const usable = buffer.length - (buffer.length % frameBytes);
    carry = buffer.subarray(usable) as Buffer<ArrayBuffer>;
    buffer = buffer.subarray(0, usable) as Buffer<ArrayBuffer>;

    for (let position = 0; position < buffer.length; position += frameBytes) {
      let sum = 0;
      for (let channel = 0; channel < format.channels; channel++) {
        sum += buffer.readInt16LE(position + channel * bytesPerSample);
      }
      frame[filled++] = sum / format.channels / 32768;
      if (filled === frameSize) {
        yield { samples: frame, index: index++ };
        frame = new Float32Array(frameSize);
        filled = 0;
      }
    }
  }

  if (filled > 0) {
    frame.fill(0, filled);
    yield { samples: frame, index };
  }
}

export async function wavDuration(filePath: string): Promise<number> {
  const format = await readWavFormat(filePath);
  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  return format.dataLength / (bytesPerFrame * format.sampleRate);
}
