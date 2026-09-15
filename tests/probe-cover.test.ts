import { describe, it, expect } from 'vitest';
import { describeMedia } from '../src/util/ffmpeg.js';

/**
 * Обложка внутри файла — это видеопоток (SPEC FR-1).
 *
 * `--embed-thumbnail` кладёт картинку в контейнер как поток с пометкой
 * `attached_pic`. Для плеера это нормально, а для стадий — ловушка: скачанный
 * «только звук» файл выглядел бы видео, S7 собрал бы mp4 со статичной картинкой
 * вместо m4a, а испортить могло любой чужой файл с обложкой.
 */
describe('§FR-1: ffprobe и обложка', () => {
  const audio = { codec_type: 'audio', channels: 2, sample_rate: '48000' };
  const cover = { codec_type: 'video', disposition: { attached_pic: 1 } };

  it('файл только со звуком и обложкой — не видео', () => {
    const info = describeMedia({ format: { duration: '213.4' }, streams: [cover, audio] });
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(true);
    expect(info.audioSampleRate).toBe(48000);
  });

  it('видео с обложкой остаётся видео', () => {
    const info = describeMedia({
      format: { duration: '213.4' },
      streams: [{ codec_type: 'video', height: 1080 }, audio, cover],
    });
    expect(info.hasVideo).toBe(true);
  });

  it('несколько обложек видео не делают', () => {
    const info = describeMedia({ format: { duration: '10' }, streams: [cover, cover, audio] });
    expect(info.hasVideo).toBe(false);
  });

  it('пустой ответ не падает', () => {
    const info = describeMedia({});
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(false);
    expect(info.durationSeconds).toBe(0);
  });
});
