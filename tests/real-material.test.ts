import { describe, it, expect } from 'vitest';
import { MAX_BRACKETED_WORDS, MAX_WORD_SECONDS, dropBracketedGroups, dtwPreset, parseWhisperWords } from '../src/providers/asr/whispercpp.js';
import { boundedTargetChars, collectMisfits, targetChars, MAX_EXPANSION } from '../src/stages/s3-translate.js';
import { makeSegment } from '../src/core/types.js';

/**
 * Правила, выведенные из первого реального эпизода (11:47, музыка, паузы).
 * Синтетическая фикстура их не ловила: там не было ни длинных пауз,
 * ни служебных токенов whisper.
 */

const item = (text: string, from: number, to: number) => ({ text, offsets: { from: from * 1000, to: to * 1000 } });

describe('Разбор пословного вывода whisper на реальной записи', () => {
  it('отбрасывает музыку, шум и маркеры смены говорящего', () => {
    const words = parseWhisperWords({
      transcription: [
        item(' Engines', 53.65, 54.11),
        item(' [MUSIC]', 55.72, 57.72),
        item(' >>', 57.72, 57.88),
        item(' [NOISE]', 85.1, 89.52),
        item(' Fuck.', 57.88, 58.48),
      ],
    });
    expect(words.map((w) => w.word)).toEqual(['Engines', 'Fuck.']);
  });

  it('обрезает слово, растянутое через паузу, но сохраняет его начало', () => {
    // Реальный случай: «you» получило 55.93 → 196.52 — 140 секунд.
    const [word] = parseWhisperWords({ transcription: [item(' you', 55.93, 196.52)] });
    expect(word!.start).toBeCloseTo(55.93, 3);
    expect(word!.end - word!.start).toBeCloseTo(MAX_WORD_SECONDS, 3);
  });

  it('нормальные слова не трогает', () => {
    const [word] = parseWhisperWords({ transcription: [item(' holding', 51.41, 51.96)] });
    expect(word!.end).toBeCloseTo(51.96, 3);
  });
});

describe('FR-2: начало слова по DTW, а не по эвристике whisper', () => {
  const dtwItem = (text: string, from: number, to: number, stamps: number[]) => ({
    ...item(text, from, to),
    tokens: stamps.map((stamp) => ({ text, t_dtw: stamp })),
  });

  it('первые слова фразы начинаются там, где их слышно, а не на начале сегмента', () => {
    // Реальный случай: эвристика ставит «FD corridor destabilization» на 13.76,
    // DTW — на 14.14 / 14.60 / 14.94; VAD видит речь с 14.95.
    const words = parseWhisperWords({
      transcription: [
        dtwItem(' FD', 13.76, 13.76, [1414, 1428]),
        dtwItem(' corridor', 13.76, 13.76, [1460]),
        dtwItem(' destabilization,', 13.76, 15.66, [1494, 1510, 1552, 1580]),
        dtwItem(' emergency', 15.66, 16.37, [1614]),
      ],
    });
    expect(words.map((w) => w.start)).toEqual([14.14, 14.6, 14.94, 16.14]);
    // Конец — не позже начала следующего слова и эвристического конца.
    expect(words[0]!.end).toBeCloseTo(14.6, 3);
    expect(words[2]!.end).toBeCloseTo(15.66, 3);
  });

  it('без DTW-таймкодов остаётся эвристика, музыка и маркеры отбрасываются', () => {
    const words = parseWhisperWords({
      transcription: [
        dtwItem(' [MUSIC]', 0.05, 13.0, [44, 282]),
        dtwItem(' >>', 13.76, 13.76, [1162]),
        { ...item(' Fuck.', 57.88, 58.48), tokens: [{ text: ' Fuck.', t_dtw: -1 }] },
      ],
    });
    expect(words).toEqual([{ word: 'Fuck.', start: 57.88, end: 58.48 }]);
  });

  it('последнее слово фразы не тянется через паузу и не короче 0.3 с без опоры', () => {
    const [stretched] = parseWhisperWords({ transcription: [dtwItem(' you', 55.93, 196.52, [5600])] });
    expect(stretched!.start).toBe(56);
    expect(stretched!.end - stretched!.start).toBeCloseTo(MAX_WORD_SECONDS, 3);
    const [lonely] = parseWhisperWords({ transcription: [dtwItem(' Hi', 10, 10, [1000])] });
    expect(lonely!.end).toBeCloseTo(10.3, 3);
  });

  it('имя набора голов для DTW выводится из имени модели', () => {
    expect(dtwPreset('small')).toBe('small');
    expect(dtwPreset('base.en')).toBe('base.en');
    expect(dtwPreset('large-v3')).toBe('large.v3');
    expect(dtwPreset('large-v3-turbo')).toBe('large.v3.turbo');
  });
});

describe('FR-3: перевод не длиннее оригинала более чем вдвое', () => {
  it('одно слово в огромном слоте не превращается в монолог', () => {
    // Реальный случай: слот 96.7 с, одно слово, перевод на 752 символа.
    const bySlot = targetChars(96.7, 11.5);
    const bounded = boundedTargetChars('you', 96.7, 11.5);
    expect(bySlot).toBeGreaterThan(1000);
    expect(bounded).toBeLessThanOrEqual(Math.max(8, Math.round(3 * MAX_EXPANSION)));
  });

  it('обычная реплика ограничивается слотом, а не оригиналом', () => {
    const text = 'So what do you think about the new plan?';
    expect(boundedTargetChars(text, 1.82, 11.5)).toBe(targetChars(1.82, 11.5));
  });

  it('не просит удлинить перевод, если он уже исчерпал оригинал', () => {
    const segment = makeSegment({ id: 0, start: 0, end: 40, text_en: 'Yes.', text_ru: 'Да, конечно.' });
    const misfits = collectMisfits([segment], 11.5, 0.15, 0.25);
    expect(misfits).toEqual([]);
  });

  it('по-прежнему просит сократить слишком длинный перевод', () => {
    const segment = makeSegment({ id: 0, start: 0, end: 1, text_en: 'Yes.', text_ru: 'а'.repeat(60) });
    const misfits = collectMisfits([segment], 11.5, 0.15, 0.25);
    expect(misfits).toHaveLength(1);
    expect(misfits[0]!.action).toBe('shorten');
  });
});

describe('FR-2: описания звуков в скобках не попадают в субтитры', () => {
  const words = (...list: string[]) => list.map((word) => ({ word }));

  it('группа в скобках выбрасывается целиком', () => {
    // Реальный случай: в титрах оригинала оставалось «(eerie» — пословный режим
    // whisper разрезает «(eerie music)» на два токена.
    expect(dropBracketedGroups(words('(eerie', 'music)', 'Hello', 'there')).map((w) => w.word)).toEqual(['Hello', 'there']);
    expect(dropBracketedGroups(words('[door', 'creaks]', 'Run.')).map((w) => w.word)).toEqual(['Run.']);
  });

  it('одиночный токен в скобках тоже уходит', () => {
    expect(dropBracketedGroups(words('(panting)', 'Go')).map((w) => w.word)).toEqual(['Go']);
  });

  it('незакрытая скобка не съедает остаток реплики', () => {
    const kept = dropBracketedGroups(words('(then', 'he', 'said', 'nothing', 'at', 'all'));
    expect(kept.map((w) => w.word)).toEqual(['(then', 'he', 'said', 'nothing', 'at', 'all']);
  });

  it('слишком длинная группа не считается описанием звука', () => {
    const long = words('(a', ...Array.from({ length: MAX_BRACKETED_WORDS + 2 }, () => 'word'), 'end)');
    expect(dropBracketedGroups(long).length).toBe(long.length);
  });

  it('разбор вывода whisper убирает такие группы вместе с таймкодами', () => {
    const parsed = parseWhisperWords({
      transcription: [item(' (eerie', 1, 1.4), item(' music)', 1.4, 2.2), item(' Hello.', 2.3, 2.8)],
    });
    expect(parsed.map((w) => w.word)).toEqual(['Hello.']);
  });
});
