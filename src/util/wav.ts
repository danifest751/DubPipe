import { createReadStream } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';

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

/**
 * Читает заголовок RIFF и находит блок `data`.
 *
 * Блоки перебираются по их собственным длинам, без ограничения на то, где
 * `data` окажется. Раньше читались только первые 4 КБ файла: у WAV с крупными
 * метаданными — обложкой, длинным блоком LIST — блок `data` в них не попадал, и
 * файл объявлялся негодным. На нашем материале это не стреляло, потому что все
 * WAV пишет ffmpeg, но второй читатель заголовков в проекте (для основного тона)
 * умел это с самого начала, и два ответа на один вопрос — ровно то, от чего
 * проект избавляется.
 */
export async function readWavFormat(filePath: string): Promise<WavFormat> {
  const handle = await open(filePath, 'r');
  try {
    const riff = Buffer.alloc(12);
    const { bytesRead } = await handle.read(riff, 0, 12, 0);
    if (bytesRead < 12 || riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`Файл не является WAV: ${filePath}`);
    }

    let offset = 12;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    const chunk = Buffer.alloc(8);
    for (;;) {
      const header = await handle.read(chunk, 0, 8, offset);
      if (header.bytesRead < 8) break;
      const id = chunk.toString('ascii', 0, 4);
      const size = chunk.readUInt32LE(4);
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(16);
        await handle.read(fmt, 0, 16, offset + 8);
        channels = fmt.readUInt16LE(2);
        sampleRate = fmt.readUInt32LE(4);
        bitsPerSample = fmt.readUInt16LE(14);
      } else if (id === 'data') {
        return {
          sampleRate,
          channels: channels || 1,
          bitsPerSample: bitsPerSample || 16,
          dataOffset: offset + 8,
          dataLength: size,
        };
      }
      // Нечётные блоки дополняются байтом до чётной границы — так устроен RIFF.
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

/** Клип целиком в память: реплика — это секунды, а не часы. */
export async function readClip(filePath: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const format = await readWavFormat(filePath);
  if (format.bitsPerSample !== 16) throw new Error(`поддерживается только 16-битный PCM, получено ${format.bitsPerSample} бит`);
  const handle = await open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(format.dataLength);
    await handle.read(bytes, 0, bytes.length, format.dataOffset);
    const step = 2 * format.channels;
    const samples = new Float32Array(Math.floor(format.dataLength / step));
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * step) / 32768;
    return { samples, sampleRate: format.sampleRate };
  } finally {
    await handle.close();
  }
}

/** Пишет моно 16 бит: заголовок RIFF на 44 байта и отсчёты. */
export async function writeClip(filePath: string, samples: Float32Array, sampleRate: number): Promise<void> {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(filePath, Buffer.concat([header, data]));
}
