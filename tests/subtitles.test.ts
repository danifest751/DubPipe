import { describe, it, expect } from 'vitest';
import {
  cueProblems,
  formatSrt,
  parseSrt,
  planCues,
  readingSeconds,
  splitLongText,
  subtitleFileName,
  subtitleOptionsFrom,
  wrapCueText,
  writeSubtitleFiles,
  DEFAULT_SUBTITLE_OPTIONS,
  type Cue,
} from '../src/stages/subtitles.js';
import { parseConfig } from '../src/config/load.js';
import { makeSegment } from '../src/core/types.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const item = (id: number, start: number, end: number, text: string) => ({ id, start, end, text });

describe('FR-8: раскладка строк субтитра', () => {
  it('короткий текст остаётся одной строкой', () => {
    expect(wrapCueText('Уходим.', 42, 2)).toEqual(['Уходим.']);
  });

  it('длинный текст делится на две строки примерно поровну', () => {
    const lines = wrapCueText('Коридор ФД нестабилен, запущен аварийный разворот подпространства.', 42, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(42);
    expect(lines.join(' ')).toBe('Коридор ФД нестабилен, запущен аварийный разворот подпространства.');
    expect(Math.abs(lines[0]!.length - lines[1]!.length)).toBeLessThan(20);
  });

  it('предлог и союз не остаются в конце строки', () => {
    // Разрыв после «и» дал бы строки ровнее, но читается как обрыв мысли.
    const lines = wrapCueText('Мы уходим прямо сейчас и забираем всех', 24, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.toLowerCase().endsWith(' и')).toBe(false);
  });

  it('разрыв предпочитает знак препинания', () => {
    const lines = wrapCueText('Нет, я тебя совсем не понимаю, повтори ещё раз', 30, 2);
    expect(lines[0]!.endsWith(',')).toBe(true);
  });

  it('текст, не влезающий в титр, не теряется — его пометит проверка', () => {
    const text = 'Мы уходим прямо сейчас и забираем с собой всех выживших людей';
    const lines = wrapCueText(text, 30, 2);
    expect(lines.join(' ')).toBe(text);
    const narrow = { ...DEFAULT_SUBTITLE_OPTIONS, maxLineChars: 30 };
    expect(cueProblems({ index: 1, start: 0, end: 5, lines, segmentId: 0 }, undefined, narrow)).toContain('line_overflow');
  });

  it('в одну строку укладывает, когда больше нельзя', () => {
    expect(wrapCueText('Слово слово слово слово', 42, 1)).toEqual(['Слово слово слово слово']);
  });
});

describe('FR-8: деление длинной реплики на титры', () => {
  it('делит по границам предложений', () => {
    const parts = splitLongText('Первое предложение тут. Второе предложение здесь. Третье совсем рядом.', 40);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(40);
    expect(parts.join(' ')).toContain('Третье совсем рядом.');
  });

  it('длинное предложение без точек режет по словам', () => {
    const parts = splitLongText('слово '.repeat(40).trim(), 42);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(42);
  });

  it('короткий текст не трогает', () => {
    expect(splitLongText('Коротко.', 84)).toEqual(['Коротко.']);
    expect(splitLongText('   ', 84)).toEqual([]);
  });
});

describe('FR-8: тайминги титров', () => {
  it('растягивает слишком короткий титр до минимума', () => {
    const [cue] = planCues([item(0, 10, 10.3, 'Да.')]);
    expect(cue!.end - cue!.start).toBeCloseTo(DEFAULT_SUBTITLE_OPTIONS.minDurationSeconds, 2);
    expect(cue!.start).toBe(10);
  });

  it('обрезает слишком длинный титр', () => {
    const [cue] = planCues([item(0, 0, 30, 'Короткая фраза.')]);
    expect(cue!.end - cue!.start).toBeCloseTo(DEFAULT_SUBTITLE_OPTIONS.maxDurationSeconds, 2);
  });

  it('даёт время на чтение, если реплика была короче', () => {
    // 60 символов при 17 симв/с — не меньше 3.5 с.
    const text = 'а'.repeat(60);
    const [cue] = planCues([item(0, 0, 1, text)]);
    expect(cue!.end - cue!.start).toBeGreaterThanOrEqual(readingSeconds(text, DEFAULT_SUBTITLE_OPTIONS.maxCps) - 0.01);
  });

  it('не наезжает на следующий титр и держит зазор', () => {
    const cues = planCues([item(0, 0, 0.5, 'Первый.'), item(1, 1.2, 2.5, 'Второй.')]);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.end).toBeLessThanOrEqual(cues[1]!.start - DEFAULT_SUBTITLE_OPTIONS.gapMs / 1000 + 0.001);
  });

  it('длинную реплику превращает в несколько титров подряд', () => {
    const long = 'Первое предложение здесь. Второе предложение тоже здесь. Третье предложение в самом конце.';
    const cues = planCues([item(7, 0, 12, long)]);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every((cue) => cue.segmentId === 7)).toBe(true);
    expect(cues[0]!.start).toBe(0);
    expect(cues[cues.length - 1]!.end).toBeLessThanOrEqual(12.001);
    for (let i = 0; i < cues.length - 1; i++) expect(cues[i]!.end).toBeLessThanOrEqual(cues[i + 1]!.start);
  });

  it('нумерует подряд и пропускает пустые реплики', () => {
    const cues = planCues([item(0, 0, 2, 'Есть текст.'), item(1, 3, 4, '   '), item(2, 5, 7, 'И ещё.')]);
    expect(cues.map((cue) => cue.index)).toEqual([1, 2]);
  });
});

describe('FR-8: проверка титров и формат файла', () => {
  const cue = (start: number, end: number, lines: string[]): Cue => ({ index: 1, start, end, lines, segmentId: 0 });

  it('находит слишком быстрый, короткий, длинный и широкий титр', () => {
    expect(cueProblems(cue(0, 1, ['а'.repeat(40)]), undefined)).toContain('too_fast');
    expect(cueProblems(cue(0, 0.4, ['Да.']), undefined)).toContain('too_short');
    expect(cueProblems(cue(0, 9, ['Да.']), undefined)).toContain('too_long');
    expect(cueProblems(cue(0, 5, ['а'.repeat(60)]), undefined)).toContain('line_overflow');
    expect(cueProblems(cue(0, 5, ['а', 'б', 'в']), undefined)).toContain('too_many_lines');
  });

  it('находит наложение на следующий титр', () => {
    expect(cueProblems(cue(0, 3, ['Один.']), cue(2, 4, ['Два.']))).toContain('overlap');
    expect(cueProblems(cue(0, 1.9, ['Один.']), cue(2, 4, ['Два.']))).not.toContain('overlap');
  });

  it('нормальный титр без замечаний', () => {
    expect(cueProblems(cue(0, 2.5, ['Обычная строка титра.']), cue(3, 5, ['Следующая.']))).toEqual([]);
  });

  it('SRT пишется и читается обратно', () => {
    const cues = planCues([item(0, 1.5, 3.2, 'Первая строка. Вторая строка.'), item(1, 4, 6, 'Ещё титр.')]);
    const text = formatSrt(cues);
    expect(text).toContain('00:00:01,500 --> ');
    const parsed = parseSrt(text);
    expect(parsed).toHaveLength(cues.length);
    expect(parsed[0]!.lines.join(' ')).toBe(cues[0]!.lines.join(' '));
    expect(parsed[0]!.start).toBeCloseTo(cues[0]!.start, 3);
  });

  it('разбор переживает пустые блоки и точку вместо запятой', () => {
    const parsed = parseSrt('\n\n1\n00:00:01.000 --> 00:00:02.000\nТекст\n\n\nмусор\n\n');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.end).toBe(2);
  });

  it('имя файла строится из имени входа', () => {
    expect(subtitleFileName('C:/video/lecture.mkv', 'en')).toBe('lecture.en.srt');
    expect(subtitleFileName('C:/video/lecture.mkv', 'ru')).toBe('lecture.ru.srt');
    expect(subtitleFileName('https://youtu.be/xyz', 'en')).toBe('subtitles.en.srt');
  });

  it('настройки читаются из конфигурации', () => {
    const config = parseConfig({ subtitles: { max_line_chars: 38, max_cps: 20 } }, 'тест');
    const options = subtitleOptionsFrom(config);
    expect(options.maxLineChars).toBe(38);
    expect(options.maxCps).toBe(20);
    expect(options.minDurationSeconds).toBe(1);
  });
});

describe('FR-8: перевод идёт за озвучкой, оригинал остаётся на месте', () => {
  // Укладка вправе сдвинуть реплику (по умолчанию до 1.5 с). Пока титры
  // строились строго по исходным таймкодам, русская строка показывалась там,
  // где говорили на языке оригинала, а русский голос звучал в стороне.
  const shifted = () => [
    makeSegment({
      id: 0,
      start: 10,
      end: 12,
      text_en: 'Get us out of here.',
      text_ru: 'Уводи нас отсюда.',
      shift_ms: 900,
    }),
  ];

  const cuesOf = async (lang: string, dir: string, files: Awaited<ReturnType<typeof writeSubtitleFiles>>['files']) => {
    const file = files.find((item) => item.lang === lang)!;
    expect(file).toBeDefined();
    return parseSrt((await readFile(path.join(dir, path.basename(file.path)), 'utf8')).replace(/^﻿/, ''));
  };

  it('русский титр сдвигается вместе с репликой, английский — нет', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dubpipe-subs-'));
    try {
      const { files } = await writeSubtitleFiles(shifted(), 'episode.mkv', dir);
      const ru = await cuesOf('ru', dir, files);
      const en = await cuesOf('en', dir, files);

      expect(ru[0]!.start).toBeCloseTo(10.9, 2);
      expect(ru[0]!.end).toBeCloseTo(12.9, 2);
      expect(en[0]!.start).toBeCloseTo(10, 2);
      expect(en[0]!.end).toBeCloseTo(12, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('без укладки сдвига нет и оба титра совпадают по времени', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dubpipe-subs-'));
    try {
      const segments = shifted();
      segments[0]!.shift_ms = null;
      const { files } = await writeSubtitleFiles(segments, 'episode.mkv', dir);
      const ru = await cuesOf('ru', dir, files);
      const en = await cuesOf('en', dir, files);
      expect(ru[0]!.start).toBeCloseTo(en[0]!.start, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
