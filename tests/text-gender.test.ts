import { describe, it, expect } from 'vitest';
import { makeSegment, type Segment } from '../src/core/types.js';
import { addressHits, markWord, selfHits, speakerGenderByText, vocativeNames } from '../src/core/text-gender.js';

/**
 * Пол говорящего по русскому тексту — вторая улика рядом с тоном голоса.
 *
 * Нужна она потому, что тон на реальном звуке голодает: на третьем эпизоде
 * устойчивый тон нашёлся у 9% кадров, speaker_0 замерен на 171 Гц (полоса, где
 * определитель молчит), а у speaker_2 звонкой речи всего 0.62 с.
 */

const line = (id: number, speaker: string, ru: string, start = id * 10): Segment =>
  makeSegment({ id, start, end: start + 3, speaker, text_en: `line ${id}`, text_ru: ru });

describe('род слова', () => {
  it('видит прошедшее время и краткие прилагательные', () => {
    expect(markWord('пришёл')).toBe('м');
    expect(markWord('пришла')).toBe('ж');
    expect(markWord('выразился')).toBe('м');
    expect(markWord('справилась')).toBe('ж');
    expect(markWord('должен')).toBe('м');
    expect(markWord('должна')).toBe('ж');
  });

  it('молчит там, где рода не видно', () => {
    expect(markWord('знаю')).toBeNull();
    expect(markWord('существо')).toBeNull();
    // Существительные с глагольным окончанием — списком: «я стол» не бывает,
    // а «ты — скала» бывает, и род там не про говорящего.
    expect(markWord('зал')).toBeNull();
    expect(markWord('стол')).toBeNull();
    expect(markWord('скала')).toBeNull();
    // Короткие глаголы при этом нужны: «я был», «ты мог».
    expect(markWord('был')).toBe('м');
    expect(markWord('была')).toBe('ж');
  });
});

describe('улики в реплике', () => {
  it('берёт ближайшее сказуемое, а не любое слово в строке', () => {
    // «пришла» относится к ней, а не к говорящему: окно до неё не дотягивается.
    expect(selfHits('Я знаю только то, что она пришла первой')).toEqual([]);
    expect(selfHits('Я пришёл именно за тобой')[0]?.gender).toBe('м');
    expect(selfHits('Я уже всё сказала')[0]?.gender).toBe('ж');
  });

  it('обращение разбирается отдельно от рассказа о себе', () => {
    expect(addressHits('Ты убил троих наших')[0]?.gender).toBe('м');
    expect(addressHits('Ты сама этого хотела')[0]?.gender).toBe('ж');
    expect(selfHits('Ты убил троих наших')).toEqual([]);
  });

  it('звательное имя вынимается из реплики', () => {
    expect(vocativeNames('Будь осторожен, Юкай')).toEqual(['Юкай']);
    expect(vocativeNames('Лиза, послушай меня')).toEqual([]);
  });
});

describe('вердикт по говорящему', () => {
  it('двух согласных улик о себе достаточно', () => {
    const verdict = speakerGenderByText([
      line(1, 'speaker_0', 'Я пришёл именно за тобой'),
      line(2, 'speaker_0', 'Я же сказал тебе'),
    ]);
    expect(verdict['speaker_0']?.gender).toBe('м');
    expect(verdict['speaker_0']?.self).toBe(2);
  });

  it('одной улики мало: оговорка не меняет голос на весь фильм', () => {
    const verdict = speakerGenderByText([line(1, 'speaker_0', 'Я пришёл')]);
    expect(verdict['speaker_0']?.gender).toBe('—');
  });

  it('спорящие улики вердикта не дают', () => {
    // Цитата чужих слов, пересказ, издёвка — машине это не разобрать.
    const verdict = speakerGenderByText([
      line(1, 'speaker_0', 'Я сказал ей правду'),
      line(2, 'speaker_0', 'Я сказала бы иначе'),
      line(3, 'speaker_0', 'Я пришёл первым'),
    ]);
    expect(verdict['speaker_0']?.gender).toBe('—');
  });

  it('обращение считается собеседнику, когда в сцене ровно двое', () => {
    const verdict = speakerGenderByText([
      line(1, 'speaker_0', 'Ты сказала это вчера', 0),
      line(2, 'speaker_1', 'Не помню такого', 4),
      line(3, 'speaker_0', 'Ты сама так решила', 8),
    ]);
    expect(verdict['speaker_1']?.gender).toBe('ж');
    expect(verdict['speaker_1']?.address).toBe(2);
    // Говорящему эти улики не приписываются.
    expect(verdict['speaker_0']?.gender ?? '—').toBe('—');
  });

  it('при трёх участниках сцены обращение не засчитывается', () => {
    const verdict = speakerGenderByText([
      line(1, 'speaker_0', 'Ты сказала это вчера', 0),
      line(2, 'speaker_1', 'Не помню', 4),
      line(3, 'speaker_2', 'И я не помню', 6),
      line(4, 'speaker_0', 'Ты сама так решила', 8),
    ]);
    expect(verdict['speaker_1']?.gender ?? '—').toBe('—');
  });

  it('названное имя опознаёт собеседника и в многолюдной сцене', () => {
    const segments = [
      line(1, 'speaker_0', 'Ты сама так решила, Лиза', 0),
      line(2, 'speaker_1', 'Не помню', 4),
      line(3, 'speaker_2', 'И я не помню', 6),
      line(4, 'speaker_0', 'Ты обещала мне, Лиза', 8),
    ];
    const verdict = speakerGenderByText(segments, { names: { speaker_1: 'Лиза' } });
    expect(verdict['speaker_1']?.gender).toBe('ж');
  });
});
