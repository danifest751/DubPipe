import { describe, it, expect } from 'vitest';
import { mergeAdjacent, snapToSpeech, type SpeechRegion } from '../src/providers/vad/silero.js';
import { mergeWordsIntoSentences } from '../src/stages/s2-segments.js';
import type { WordTiming } from '../src/core/types.js';

const regions = (items: Array<[number, number]>): SpeechRegion[] =>
  items.map(([start, end]) => ({ start, end }));

describe('VAD: объединение речевых окон', () => {
  it('склеивает пересекающиеся и соприкасающиеся окна', () => {
    expect(mergeAdjacent(regions([[0, 1], [0.9, 2], [3, 4]]))).toEqual(regions([[0, 2], [3, 4]]));
  });

  it('сортирует окна перед склейкой', () => {
    expect(mergeAdjacent(regions([[3, 4], [0, 1]]))).toEqual(regions([[0, 1], [3, 4]]));
  });
});

describe('FR-2: подтяжка границ реплики к речи', () => {
  const speech = regions([
    [0.58, 2.4],
    [2.98, 5.79],
  ]);

  it('подтягивает завышенный конец, даже если он вне окна', () => {
    // Именно этот случай даёт whisper: конец реплики растянут до начала следующей.
    const snapped = snapToSpeech({ start: 0.58, end: 3.02 }, speech, 400);
    expect(snapped.start).toBeCloseTo(0.58, 2);
    expect(snapped.end).toBeCloseTo(2.4, 2);
  });

  it('не считает своим окно, которое лишь задевает реплику', () => {
    // Окно 2.98–5.79 пересекается с репликой всего на 40 мс — это соседняя речь.
    const snapped = snapToSpeech({ start: 0.58, end: 3.02 }, speech, 400);
    expect(snapped.end).toBeLessThan(2.9);
  });

  it('не обрезает реплику внутри последнего слова', () => {
    const words: WordTiming[] = [
      { word: 'a', start: 1.0, end: 1.4 },
      { word: 'quiet', start: 2.6, end: 3.0 },
    ];
    // VAD пропустил тихое последнее слово: конец не должен уехать раньше его начала.
    const snapped = snapToSpeech({ start: 1.0, end: 3.0, words }, regions([[1.0, 1.5]]), 400);
    expect(snapped.end).toBeGreaterThanOrEqual(2.6);
  });

  it('оставляет границы как есть, когда речевых окон нет', () => {
    const segment = { start: 10, end: 12 };
    expect(snapToSpeech(segment, [], 400)).toEqual(segment);
  });

  it('подтягивает начало только при малой коррекции', () => {
    const snapped = snapToSpeech({ start: 0.2, end: 2.4 }, speech, 400);
    expect(snapped.start).toBeCloseTo(0.58, 2); // 380 мс — в пределах окна
    const far = snapToSpeech({ start: 0.0, end: 2.4 }, speech, 200);
    expect(far.start).toBe(0.0); // 580 мс — вне окна
  });
});

describe('FR-2: сборка реплик из пословного распознавания', () => {
  const words: WordTiming[] = [
    { word: 'Hello', start: 0.0, end: 0.4 },
    { word: 'there.', start: 0.4, end: 0.9 },
    { word: 'How', start: 1.1, end: 1.3 },
    { word: 'are', start: 1.3, end: 1.5 },
    { word: 'you?', start: 1.5, end: 1.9 },
  ];

  it('режет реплики по знакам конца предложения', () => {
    const segments = mergeWordsIntoSentences(words);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text).toBe('Hello there.');
    expect(segments[1]!.text).toBe('How are you?');
    expect(segments[0]!.start).toBe(0);
    expect(segments[0]!.end).toBeCloseTo(0.9, 3);
  });

  it('режет по длинной паузе даже без знака препинания', () => {
    const withPause: WordTiming[] = [
      { word: 'one', start: 0, end: 0.4 },
      { word: 'two', start: 2.0, end: 2.4 },
    ];
    expect(mergeWordsIntoSentences(withPause, { maxGapMs: 700 })).toHaveLength(2);
  });

  it('не режет короткую паузу', () => {
    const tight: WordTiming[] = [
      { word: 'one', start: 0, end: 0.4 },
      { word: 'two', start: 0.5, end: 0.9 },
    ];
    expect(mergeWordsIntoSentences(tight, { maxGapMs: 700 })).toHaveLength(1);
  });

  it('режет по предельной длительности', () => {
    const long: WordTiming[] = Array.from({ length: 20 }, (_, i) => ({
      word: `w${i}`,
      start: i * 1.0,
      end: i * 1.0 + 0.9,
    }));
    const segments = mergeWordsIntoSentences(long, { maxSeconds: 5 });
    expect(segments.length).toBeGreaterThan(2);
    for (const segment of segments) expect(segment.end - segment.start).toBeLessThanOrEqual(6);
  });

  it('сохраняет word-таймкоды в реплике', () => {
    const segments = mergeWordsIntoSentences(words);
    expect(segments[0]!.words).toHaveLength(2);
    expect(segments[1]!.words![0]!.word).toBe('How');
  });

  it('пустой ввод даёт пустой результат', () => {
    expect(mergeWordsIntoSentences([])).toEqual([]);
  });
});
