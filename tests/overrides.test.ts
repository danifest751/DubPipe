import { describe, it, expect } from 'vitest';
import { applyOverrides, autoVoiceMap, EMPTY_OVERRIDES, effectiveVoice, normalizeOverrides, planReview } from '../src/core/overrides.js';
import { parseConfig } from '../src/config/load.js';
import { makeSegment } from '../src/core/types.js';

const config = parseConfig(
  { tts: { default_voice: 'ru_RU-irina-medium', voice_map: { speaker_1: 'ru_RU-dmitri-medium' } }, mix: { background_gain_db: -6, voice_gain_db: 0, duck_db: -18 } },
  'тест',
);

const voiced = (id: number, speaker: string, ru: string) =>
  makeSegment({ id, start: id, end: id + 1, text_en: 'x', text_ru: ru, speaker, tts_file: `${id}.wav`, tts_duration: 0.8, aligned_file: `${id}a.wav`, tempo: 1.1, shift_ms: 0 });

describe('§16.4: правки видео поверх настроек', () => {
  it('нормализует сырой JSON: мусор отбрасывается', () => {
    const parsed = normalizeOverrides({ voices: { speaker_0: ' ru_RU-denis-medium ', speaker_1: 7 }, mix: { duck_db: -12, voice_gain_db: 'x', other: 1 } });
    expect(parsed).toEqual({ voices: { speaker_0: 'ru_RU-denis-medium' }, mix: { duck_db: -12 } });
    expect(normalizeOverrides(null)).toEqual(EMPTY_OVERRIDES);
  });

  it('накладывает голоса и громкости на конфигурацию', () => {
    const merged = applyOverrides(config, { voices: { speaker_0: 'ru_RU-denis-medium' }, mix: { background_gain_db: -14 } });
    expect(merged.tts.voice_map).toEqual({ speaker_1: 'ru_RU-dmitri-medium', speaker_0: 'ru_RU-denis-medium' });
    expect(merged.mix.background_gain_db).toBe(-14);
    expect(merged.mix.duck_db).toBe(-18);
    expect(config.mix.background_gain_db).toBe(-6);
  });

  it('голос спикера: правка видео > voice_map > голос по умолчанию', () => {
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_1')).toBe('ru_RU-dmitri-medium');
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_9')).toBe('ru_RU-irina-medium');
    expect(effectiveVoice(config, { voices: { speaker_1: 'ru_RU-denis-medium' }, mix: {} }, 'speaker_1')).toBe('ru_RU-denis-medium');
  });
});

describe('FR-5: голоса по полу спикеров', () => {
  const profiles = {
    speaker_0: { gender: 'м' as const, f0: 105, voicedSeconds: 6 },
    speaker_1: { gender: 'ж' as const, f0: 188, voicedSeconds: 6 },
    speaker_2: { gender: 'м' as const, f0: 110, voicedSeconds: 6 },
    speaker_3: { gender: '—' as const, f0: 160, voicedSeconds: 6 },
  };

  it('мужчинам — мужские голоса по кругу, женщине — женский, неуверенному — ничего', () => {
    const map = autoVoiceMap(profiles, config);
    expect(map['speaker_0']).toBe('ru_RU-denis-medium');
    expect(map['speaker_2']).toBe('ru_RU-dmitri-medium');
    expect(map['speaker_1']).toBeUndefined(); // назначен в voice_map — не трогаем
    expect(map['speaker_3']).toBeUndefined();
  });

  it('голос по умолчанию идёт первым, если его пол подходит', () => {
    const female = { speaker_0: profiles.speaker_1, speaker_2: profiles.speaker_1 };
    expect(autoVoiceMap(female, config)['speaker_0']).toBe('ru_RU-irina-medium');
  });

  it('порядок приоритетов: правка видео > настройки > пол > по умолчанию', () => {
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_0', profiles)).toBe('ru_RU-denis-medium');
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_1', profiles)).toBe('ru_RU-dmitri-medium');
    expect(effectiveVoice(config, { voices: { speaker_0: 'ru_RU-ruslan-medium' }, mix: {} }, 'speaker_0', profiles)).toBe('ru_RU-ruslan-medium');
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_3', profiles)).toBe('ru_RU-irina-medium');
    expect(applyOverrides(config, EMPTY_OVERRIDES, profiles).tts.voice_map['speaker_2']).toBe('ru_RU-dmitri-medium');
  });
});

describe('§16.4: план пересведения после правок', () => {
  const previous = [voiced(0, 'speaker_0', 'Привет.'), voiced(1, 'speaker_1', 'Пока.'), voiced(2, 'speaker_0', 'Да.')];

  it('смена голоса спикера снимает синтез только с его реплик', () => {
    const plan = planReview(config, previous, previous, EMPTY_OVERRIDES, { voices: { speaker_0: 'ru_RU-denis-medium' }, mix: {} });
    expect(plan.affected).toEqual([0, 2]);
    expect(plan.fromStage).toBe('s5');
    expect(plan.segments[0]!.tts_file).toBeNull();
    expect(plan.segments[0]!.aligned_file).toBeNull();
    expect(plan.segments[1]!.tts_file).toBe('1.wav');
  });

  it('смена спикера и правка перевода тоже требуют синтеза', () => {
    const next = previous.map((segment) => ({ ...segment }));
    next[1]!.speaker = 'speaker_0';
    next[2]!.text_ru = 'Нет.';
    const plan = planReview(config, previous, next, EMPTY_OVERRIDES, EMPTY_OVERRIDES);
    expect(plan.affected).toEqual([1, 2]);
  });

  it('смена спикера на спикера с тем же голосом синтеза не требует', () => {
    const next = previous.map((segment) => ({ ...segment }));
    next[2]!.speaker = 'speaker_5'; // голос по умолчанию — тот же, что у speaker_0
    const plan = planReview(config, previous, next, EMPTY_OVERRIDES, EMPTY_OVERRIDES);
    expect(plan.affected).toEqual([]);
    expect(plan.fromStage).toBeNull();
  });

  it('только громкости — одно пересведение', () => {
    const plan = planReview(config, previous, previous, EMPTY_OVERRIDES, { voices: {}, mix: { background_gain_db: -12 } });
    expect(plan.affected).toEqual([]);
    expect(plan.fromStage).toBe('s7');
    // Громкость, равная настройке по умолчанию, — не изменение.
    expect(planReview(config, previous, previous, EMPTY_OVERRIDES, { voices: {}, mix: { duck_db: -18 } }).fromStage).toBeNull();
  });
});
