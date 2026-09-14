import { describe, it, expect } from 'vitest';
import {
  buildSegments,
  collapseRepeats,
  isHallucination,
  isNonSpeech,
  trimLoopedText,
  markOverlaps,
  refineBoundaries,
  splitLongSegment,
  segmentsSummary,
  MIN_SEGMENT_SECONDS,
  type RawSegment,
} from '../src/stages/s2-segments.js';
import { makeSegment, type WordTiming } from '../src/core/types.js';

/** Builds evenly spaced word timings, optionally with a pause before one word. */
function words(count: number, start: number, step: number, pauseBefore?: { index: number; gap: number }): WordTiming[] {
  const result: WordTiming[] = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    if (pauseBefore && pauseBefore.index === i) cursor += pauseBefore.gap;
    result.push({ word: `w${i}`, start: cursor, end: cursor + step * 0.8 });
    cursor += step;
  }
  return result;
}

describe('FR-2: отбрасывание неречевых сегментов', () => {
  it('распознаёт служебные пометки как неречь', () => {
    expect(isNonSpeech('[MUSIC]')).toBe(true);
    expect(isNonSpeech('(applause)')).toBe(true);
    expect(isNonSpeech('[BLANK_AUDIO]')).toBe(true);
    expect(isNonSpeech('   ')).toBe(true);
    expect(isNonSpeech('...')).toBe(true);
    expect(isNonSpeech('Hello there')).toBe(false);
  });

  it('отбрасывает реплики короче 0.4 с', () => {
    const raw: RawSegment[] = [
      { start: 0, end: 0.3, text: 'too short' },
      { start: 1, end: 2, text: 'long enough' },
    ];
    const segments = buildSegments(raw);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text_en).toBe('long enough');
    expect(segments[0]!.end - segments[0]!.start).toBeGreaterThanOrEqual(MIN_SEGMENT_SECONDS);
  });
});

describe('FR-2: уточнение границ по word-таймкодам', () => {
  it('подтягивает границы к первому и последнему слову внутри окна', () => {
    const segment: RawSegment = {
      start: 10,
      end: 13,
      text: 'a b',
      words: [
        { word: 'a', start: 10.2, end: 10.5 },
        { word: 'b', start: 12.6, end: 12.8 },
      ],
    };
    const refined = refineBoundaries(segment, 400);
    expect(refined.start).toBeCloseTo(10.2, 3);
    expect(refined.end).toBeCloseTo(12.8, 3);
  });

  it('не двигает границу, если коррекция выходит за окно', () => {
    const segment: RawSegment = {
      start: 10,
      end: 13,
      text: 'a b',
      words: [
        { word: 'a', start: 11.5, end: 11.7 },
        { word: 'b', start: 12.0, end: 12.2 },
      ],
    };
    // Начало слова 11.5 отстоит от 10 на 1.5 с, конец 12.2 от 13 — на 0.8 с;
    // обе коррекции больше окна ±400 мс, поэтому границы остаются исходными.
    const refined = refineBoundaries(segment, 400);
    expect(refined.start).toBe(10);
    expect(refined.end).toBe(13);
  });

  it('подтягивает только ту границу, что попала в окно', () => {
    const segment: RawSegment = {
      start: 10,
      end: 13,
      text: 'a b',
      words: [
        { word: 'a', start: 11.5, end: 11.7 },
        { word: 'b', start: 12.7, end: 12.85 },
      ],
    };
    const refined = refineBoundaries(segment, 400);
    expect(refined.start).toBe(10);
    expect(refined.end).toBeCloseTo(12.85, 3);
  });

  it('оставляет сегмент как есть без word-таймкодов', () => {
    const segment: RawSegment = { start: 5, end: 7, text: 'no words' };
    expect(refineBoundaries(segment, 400)).toEqual(segment);
  });
});

describe('FR-2: разбиение реплик длиннее 30 с', () => {
  it('режет по паузе больше 400 мс', () => {
    const segment: RawSegment = {
      start: 0,
      end: 40,
      text: 'long',
      words: words(40, 0, 1, { index: 20, gap: 0.6 }),
    };
    const parts = splitLongSegment(segment);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.end - part.start).toBeLessThanOrEqual(30);
  });

  it('понижает порог паузы, когда пауз > 400 мс нет', () => {
    const segment: RawSegment = {
      start: 0,
      end: 40,
      text: 'long',
      words: words(40, 0, 1, { index: 20, gap: 0.2 }),
    };
    const parts = splitLongSegment(segment);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.end - part.start).toBeLessThanOrEqual(30);
  });

  it('режет принудительно, когда пауз нет вовсе, и помечает флагом', () => {
    // Words butt up against each other: no gap can ever exceed a threshold.
    const tight: WordTiming[] = Array.from({ length: 40 }, (_, i) => ({
      word: `w${i}`,
      start: i,
      end: i + 1,
    }));
    const segment: RawSegment = { start: 0, end: 40, text: 'x', words: tight };
    const parts = splitLongSegment(segment);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.some((p) => p.flags?.includes('force_split'))).toBe(true);
    for (const part of parts) expect(part.end - part.start).toBeLessThanOrEqual(30);
  });

  // Регрессия: на реальном эпизоде whisper выдал одно «слово» длиной в минуту
  // на музыкальном вступлении, и разбиение уходило в бесконечную рекурсию —
  // «Maximum call stack size exceeded» на стадии распознавания.
  it('одно слово длиннее предела возвращается как есть, а не роняет стек', () => {
    const segment: RawSegment = { start: 0, end: 60, text: 'Music', words: [{ word: 'Music', start: 0, end: 60 }] };
    expect(splitLongSegment(segment)).toEqual([segment]);
  });

  it('один токен без word-таймкодов тоже неделим', () => {
    const segment: RawSegment = { start: 0, end: 60, text: 'Music' };
    expect(splitLongSegment(segment)).toEqual([segment]);
  });

  it('длинное слово внутри реплики отделяется от остальных и остаётся целым', () => {
    const segment: RawSegment = {
      start: 0,
      end: 60,
      text: 'Intro Music',
      words: [
        { word: 'Intro', start: 0, end: 5 },
        { word: 'Music', start: 5, end: 60 },
      ],
    };
    const parts = splitLongSegment(segment);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.text).toBe('Intro');
    expect(parts[1]!.text).toBe('Music');
    expect(parts[1]!.end - parts[1]!.start).toBeCloseTo(55, 3);
  });

  it('не трогает реплики короче предела', () => {
    const segment: RawSegment = { start: 0, end: 12, text: 'fine', words: words(12, 0, 1) };
    expect(splitLongSegment(segment)).toEqual([segment]);
  });
});

describe('§8: флаг overlap', () => {
  it('помечает обе перекрывающиеся реплики', () => {
    const segments = [
      makeSegment({ id: 0, start: 0, end: 3, text_en: 'first' }),
      makeSegment({ id: 1, start: 2.5, end: 5, text_en: 'second' }),
      makeSegment({ id: 2, start: 6, end: 7, text_en: 'third' }),
    ];
    const marked = markOverlaps(segments);
    expect(marked[0]!.overlap).toBe(true);
    expect(marked[1]!.overlap).toBe(true);
    expect(marked[2]!.overlap).toBe(false);
  });
});

describe('S2: сборка итоговых сегментов', () => {
  it('сортирует, перенумеровывает и заполняет контракт §5.1', () => {
    const raw: RawSegment[] = [
      { start: 5, end: 6.5, text: 'second' },
      { start: 1, end: 2.5, text: 'first' },
      { start: 3, end: 3.2, text: 'dropped: too short' },
      { start: 8, end: 9, text: '[MUSIC]' },
    ];
    const segments = buildSegments(raw);
    expect(segments.map((s) => s.id)).toEqual([0, 1]);
    expect(segments.map((s) => s.text_en)).toEqual(['first', 'second']);

    const first = segments[0]!;
    expect(first.text_ru).toBeNull();
    expect(first.tts_file).toBeNull();
    expect(first.tempo).toBeNull();
    expect(first.speaker).toBe('speaker_0');
    expect(first.retranslate_count).toBe(0);
    expect(first.flags).toEqual([]);
  });

  it('считает сводку по репликам', () => {
    const segments = buildSegments([
      { start: 0, end: 2, text: 'one', speaker: 'speaker_0' },
      { start: 3, end: 4, text: 'two', speaker: 'speaker_1' },
    ]);
    const summary = segmentsSummary(segments);
    expect(summary.count).toBe(2);
    expect(summary.speechSeconds).toBe(3);
    expect(summary.speakers).toEqual(['speaker_0', 'speaker_1']);
    expect(summary.overlaps).toBe(0);
  });
});

describe('FR-2: галлюцинации whisper', () => {
  const raw = (start: number, end: number, text: string) => ({ start, end, text });

  it('служебные формулы из титров речью не считаются', () => {
    // Реальный случай: корейская дорама, 68 реплик из 412 — одна и та же формула.
    expect(isHallucination('한글 자막 제공 및 광고를 포함하고 있습니다.')).toBe(true);
    expect(isHallucination('Subtitles by the community')).toBe(true);
    expect(isHallucination('Thanks for watching!')).toBe(true);
    expect(isHallucination('Субтитры сделал энтузиаст')).toBe(true);
    expect(isHallucination('Смотрите на www.example.com')).toBe(true);
  });

  it('обычную речь не трогает', () => {
    expect(isHallucination('고마워요. 회의실은 어디예요?')).toBe(false);
    expect(isHallucination('Спасибо, я уже посмотрел этот фильм.')).toBe(false);
    expect(isHallucination('We should watch it together.')).toBe(false);
  });

  it('ловит и другие написания формулы из титров', () => {
    // Так их пишет large-v3: коротко, в первые полторы минуты, без залипания.
    expect(isHallucination('자막은 설정에서 선택하실 수 있습니다.')).toBe(true);
    expect(isHallucination('한글자막 by 한효정')).toBe(true);
    expect(isHallucination('by 한효정')).toBe(true);
    // Латинское «by» в начале живой фразы — не подпись переводчика.
    expect(isHallucination('by the way, I called him')).toBe(false);
    expect(isHallucination('Stand by me.')).toBe(false);
  });

  it('обрывок формулы в одно слово тоже отсеивается', () => {
    // Так и звучало в дубляже: модель начала формулу и оборвалась, переводчик
    // сделал из «한글» слово «Корейский», и оно прозвучало посреди диалога.
    expect(isHallucination('한글')).toBe(true);
    expect(isHallucination('자막.')).toBe(true);
    // Так их пишет large-v3: с падежной частицей и хвостом фразы отдельной репликой.
    expect(isHallucination('자막은')).toBe(true);
    expect(isHallucination('포함하고 있습니다.')).toBe(true);
    expect(isHallucination('Subtitles')).toBe(true);
    // То же слово внутри живой фразы — обычная речь.
    expect(isHallucination('한글 배우고 있어요.')).toBe(false);
    expect(isHallucination('Включи субтитры, пожалуйста.')).toBe(false);
  });

  it('зацикленный внутри реплики текст обрезается до одного вхождения', () => {
    expect(trimLoopedText('퇴근하고 던져요 퇴근하고 던져요 퇴근하고 던져요')).toBe('퇴근하고 던져요');
    expect(trimLoopedText('да да да да да да')).toBe('да');
    // Короткие фразы и обычный текст остаются целыми.
    expect(trimLoopedText('да да да')).toBe('да да да');
    expect(trimLoopedText('Мы уходим прямо сейчас и забираем всех')).toBe('Мы уходим прямо сейчас и забираем всех');
  });

  it('залипание на одном тексте схлопывается в одну реплику', () => {
    const stuck = [
      raw(10, 11, 'одно и то же'),
      raw(11, 12.2, 'одно и то же'),
      raw(12, 13.4, 'одно и то же'),
      raw(13.4, 14, 'настоящая речь'),
    ];
    const collapsed = collapseRepeats(stuck);
    expect(collapsed.map((item) => item.text)).toEqual(['одно и то же', 'настоящая речь']);
  });

  it('две одинаковые реплики с паузой между ними остаются обе', () => {
    const genuine = [raw(10, 11, 'Кто там?'), raw(30, 31, 'Кто там?')];
    expect(collapseRepeats(genuine)).toHaveLength(2);
  });

  it('две одинаковые реплики внахлёст — это залипание', () => {
    const overlapping = [raw(10, 12, 'Кто там?'), raw(11.5, 13, 'Кто там?')];
    expect(collapseRepeats(overlapping)).toHaveLength(1);
  });

  it('длинная серия без наложений — настоящая речь, её не трогаем', () => {
    // На дораме «серьёзно?» прозвучало 12 раз подряд вплотную и ни разу внахлёст.
    const genuine = Array.from({ length: 12 }, (_, index) => raw(10 + index, 11 + index, 'серьёзно?'));
    expect(collapseRepeats(genuine)).toHaveLength(12);
  });

  it('buildSegments выбрасывает галлюцинации вместе с залипанием', () => {
    const segments = buildSegments(
      [
        raw(1, 3, '한글 자막 제공 및 광고를 포함하고 있습니다.'),
        raw(3, 5, '한글 자막 제공 및 광고를 포함하고 있습니다.'),
        raw(6, 8, '고마워요. 회의실은 어디예요?'),
      ],
      { vadWindowMs: 0 },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text_en).toContain('회의실');
  });
});
