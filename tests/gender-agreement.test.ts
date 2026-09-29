import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { EMPTY_OVERRIDES, speakingGenders } from '../src/core/overrides.js';
import { agreeFirstPerson, agreePronoun, agreeWithVoices, flipGender, markWord } from '../src/core/text-gender.js';
import { makeSegment, type Segment } from '../src/core/types.js';
import type { SpeakerProfile } from '../src/providers/diarization/gender.js';
import { buildBatchRequest } from '../src/stages/s3-translate.js';

/**
 * Род в переводе — по голосу, который реплику произносит.
 *
 * Переводчик выбирал род первого лица сам: в английском «I could» рода нет. На
 * восьмом эпизоде мужские голоса говорили «я могла», женские — «я сделал»: голос
 * назначается по тону актёра, а о тоне модель не знала ничего.
 */

const line = (id: number, speaker: string, ru: string, start = id * 10): Segment =>
  makeSegment({ id, start, end: start + 3, speaker, text_en: `line ${id}`, text_ru: ru });

const profile = (gender: 'м' | 'ж' | '—', f0: number | null = null): SpeakerProfile => ({ gender, f0, voicedSeconds: 5 });

describe('перестановка рода слова', () => {
  it('правильные глаголы и возвратные', () => {
    expect(flipGender('сделала', 'м')).toBe('сделал');
    expect(flipGender('сделал', 'ж')).toBe('сделала');
    expect(flipGender('испугался', 'ж')).toBe('испугалась');
    expect(flipGender('ошиблась', 'м')).toBe('ошиблся');
  });

  it('неправильные глаголы, которых не видно по окончанию', () => {
    expect(markWord('мог')).toBe('м');
    expect(markWord('пришёл')).toBe('м');
    expect(flipGender('могла', 'м')).toBe('мог');
    expect(flipGender('смог', 'ж')).toBe('смогла');
    expect(flipGender('пришла', 'м')).toBe('пришёл');
    expect(flipGender('нашёлся', 'ж')).toBe('нашлась');
    expect(flipGender('вырос', 'ж')).toBe('выросла');
    expect(flipGender('легла', 'м')).toBe('лёг');
    expect(flipGender('привела', 'м')).toBe('привёл');
  });

  it('краткие прилагательные и «сам»', () => {
    expect(flipGender('рада', 'м')).toBe('рад');
    expect(flipGender('уверен', 'ж')).toBe('уверена');
    expect(flipGender('сам', 'ж')).toBe('сама');
  });

  it('сохраняет заглавную букву и не трогает слова без рода', () => {
    expect(flipGender('Могла', 'м')).toBe('Мог');
    expect(flipGender('знаю', 'м')).toBeNull();
    expect(flipGender('вопрос', 'ж')).toBeNull();
    expect(flipGender('сделал', 'м')).toBeNull();
  });
});

describe('всё, что говорящий говорит о себе', () => {
  const cases: Array<[string, 'м' | 'ж', string]> = [
    ['Я могла бы помочь.', 'м', 'Я мог бы помочь.'],
    ['Я была рада тебя видеть.', 'м', 'Я был рад тебя видеть.'],
    ['Я пришла и сказала правду.', 'м', 'Я пришёл и сказал правду.'],
    ['Я сделал это сам.', 'ж', 'Я сделала это сама.'],
    ['Я и сама не знаю.', 'м', 'Я и сам не знаю.'],
    ['Я бы смогла.', 'м', 'Я бы смог.'],
    ['Я должна идти.', 'м', 'Я должен идти.'],
  ];
  for (const [before, gender, after] of cases) {
    it(`${before} → ${after}`, () => {
      expect(agreeFirstPerson(before, gender).text).toBe(after);
    });
  }

  it('не трогает чужие подлежащие и собеседника', () => {
    expect(agreeFirstPerson('Я знаю, что она пришла.', 'м').text).toBe('Я знаю, что она пришла.');
    expect(agreeFirstPerson('Я думал, ты ушла.', 'ж').text).toBe('Я думала, ты ушла.');
    expect(agreeFirstPerson('Ты сказала, что я ушёл.', 'ж').text).toBe('Ты сказала, что я ушла.');
    expect(agreeFirstPerson('Я не хотела. Он ушёл сам.', 'м').text).toBe('Я не хотел. Он ушёл сам.');
  });

  it('обращение — по полу собеседника', () => {
    expect(agreePronoun('Ты пришёл вовремя.', 'ты', 'ж').text).toBe('Ты пришла вовремя.');
  });
});

describe('реплики фильма', () => {
  it('подгоняет «я» под свой голос, а «ты» — под голос единственного собеседника в сцене', () => {
    const segments = [
      line(0, 'speaker_0', 'Я могла всё исправить.', 0),
      line(1, 'speaker_1', 'Ты сделала достаточно.', 4),
    ];
    const changed = agreeWithVoices(segments, { speaker_0: 'м', speaker_1: 'ж' });
    expect(segments.map((segment) => segment.text_ru)).toEqual(['Я мог всё исправить.', 'Ты сделал достаточно.']);
    expect(changed.map((item) => item.id)).toEqual([0, 1]);
  });

  it('собеседника не угадывает, когда в сцене больше одного другого голоса', () => {
    const segments = [line(0, 'speaker_0', 'Ты пришла.', 0), line(1, 'speaker_1', 'Да.', 2), line(2, 'speaker_2', 'Ага.', 4)];
    agreeWithVoices(segments, { speaker_0: 'м', speaker_1: 'м', speaker_2: 'м' });
    expect(segments[0]!.text_ru).toBe('Ты пришла.');
  });

  it('правит разметку фраз теми же заменами', () => {
    const segment = { ...line(0, 'speaker_0', 'Я пришла, и я ушла.'), phrases: ['Я пришла,', 'и я ушла.'] };
    agreeWithVoices([segment], { speaker_0: 'м' });
    expect(segment.phrases).toEqual(['Я пришёл,', 'и я ушёл.']);
  });

  it('говорящего без известного пола не трогает', () => {
    const segments = [line(0, 'speaker_0', 'Я могла.')];
    expect(agreeWithVoices(segments, {})).toEqual([]);
  });
});

describe('пол голоса', () => {
  const speakers = { speaker_0: profile('ж', 210), speaker_1: profile('м', 110), speaker_2: profile('—') };

  it('в многоголосом дубляже — пол назначенного голоса, а не тон', () => {
    const config = parseConfig({ tts: { engine: 'piper', voice_mode: 'per_speaker' } }, 'test');
    const overrides = { ...EMPTY_OVERRIDES, voices: { speaker_0: 'ru_RU-denis-medium' } };
    const genders = speakingGenders(config, overrides, speakers);
    // Человек отдал героине мужской голос — говорить она будет им.
    expect(genders.speaker_0).toBe('м');
    expect(genders.speaker_1).toBe('м');
  });

  it('говорящий, чей пол решит перевод, переводчику не подсказывается', () => {
    const config = parseConfig({ tts: { engine: 'piper' } }, 'test');
    const firm = speakingGenders(config, EMPTY_OVERRIDES, speakers, { firmOnly: true });
    expect(firm).toEqual({ speaker_0: 'ж', speaker_1: 'м' });
    // А на синтезе он будет говорить голосом по умолчанию — и род под него.
    expect(speakingGenders(config, EMPTY_OVERRIDES, speakers).speaker_2).toBe('ж');
  });

  it('в одноголосом режиме род следует персонажу, а не диктору', () => {
    const config = parseConfig({ tts: { engine: 'piper', voice_mode: 'single', default_voice: 'ru_RU-denis-medium' } }, 'test');
    const genders = speakingGenders(config, EMPTY_OVERRIDES, speakers);
    expect(genders.speaker_0).toBe('ж');
    expect(genders.speaker_2).toBeUndefined();
  });
});

describe('запрос переводчику', () => {
  it('несёт пол голоса реплики', () => {
    const request = buildBatchRequest([line(3, 'speaker_0', ''), line(4, 'speaker_2', '')], 14, undefined, 0, undefined, true, {
      speaker_0: 'ж',
    });
    const [first, second] = request.split('\n').slice(1).map((row) => JSON.parse(row) as { speaker?: string });
    expect(first!.speaker).toBe('female');
    expect(second!.speaker).toBeUndefined();
  });
});
