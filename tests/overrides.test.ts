import { describe, it, expect } from 'vitest';
import { applyOverrides, autoVoiceMap, EMPTY_OVERRIDES, effectiveVoice, normalizeOverrides, planReview, withKnownVoices } from '../src/core/overrides.js';
import { parseConfig } from '../src/config/load.js';
import { makeSegment } from '../src/core/types.js';
import { ttsKey } from '../src/stages/s5-tts.js';
import { stageConfigSlice } from '../src/core/workspace.js';

const config = parseConfig(
  { tts: { default_voice: 'ru_RU-irina-medium', voice_map: { speaker_1: 'ru_RU-dmitri-medium' } }, mix: { background_gain_db: -6, voice_gain_db: 0, duck_db: -18 } },
  'тест',
);

/**
 * Озвученная реплика — с подписью клипа, как её оставляет синтез: без неё
 * нельзя спросить у клипа, тем ли голосом он сделан.
 */
const voiced = (id: number, speaker: string, ru: string) =>
  makeSegment({
    id,
    start: id,
    end: id + 1,
    text_en: 'x',
    text_ru: ru,
    speaker,
    tts_file: `${id}.wav`,
    tts_duration: 0.8,
    tts_key: ttsKey(effectiveVoice(config, EMPTY_OVERRIDES, speaker), ru, ''),
    aligned_file: `${id}a.wav`,
    aligned_duration: 0.8,
    tempo: 1.1,
    shift_ms: 0,
  });

describe('§16.4: правки видео поверх настроек', () => {
  it('нормализует сырой JSON: мусор отбрасывается', () => {
    const parsed = normalizeOverrides({ voices: { speaker_0: ' ru_RU-denis-medium ', speaker_1: 7 }, mix: { duck_db: -12, voice_gain_db: 'x', other: 1 } });
    expect(parsed).toEqual({ voices: { speaker_0: 'ru_RU-denis-medium' }, names: {}, mix: { duck_db: -12 } });
    expect(normalizeOverrides(null)).toEqual(EMPTY_OVERRIDES);
  });

  it('накладывает голоса и громкости на конфигурацию', () => {
    const merged = applyOverrides(config, { voices: { speaker_0: 'ru_RU-denis-medium' }, names: {}, mix: { background_gain_db: -14 } });
    expect(merged.tts.voice_map).toEqual({ speaker_1: 'ru_RU-dmitri-medium', speaker_0: 'ru_RU-denis-medium' });
    expect(merged.mix.background_gain_db).toBe(-14);
    expect(merged.mix.duck_db).toBe(-18);
    expect(config.mix.background_gain_db).toBe(-6);
  });

  it('голос спикера: правка видео > voice_map > голос по умолчанию', () => {
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_1')).toBe('ru_RU-dmitri-medium');
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_9')).toBe('ru_RU-irina-medium');
    expect(effectiveVoice(config, { voices: { speaker_1: 'ru_RU-denis-medium' }, names: {}, mix: {} }, 'speaker_1')).toBe('ru_RU-denis-medium');
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
    expect(effectiveVoice(config, { voices: { speaker_0: 'ru_RU-ruslan-medium' }, names: {}, mix: {} }, 'speaker_0', profiles)).toBe('ru_RU-ruslan-medium');
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_3', profiles)).toBe('ru_RU-irina-medium');
    expect(applyOverrides(config, EMPTY_OVERRIDES, profiles).tts.voice_map['speaker_2']).toBe('ru_RU-dmitri-medium');
  });
});

describe('§16.4: план пересведения после правок', () => {
  const previous = [voiced(0, 'speaker_0', 'Привет.'), voiced(1, 'speaker_1', 'Пока.'), voiced(2, 'speaker_0', 'Да.')];

  it('смена голоса спикера снимает синтез только с его реплик', () => {
    const plan = planReview(config, previous, previous, EMPTY_OVERRIDES, { voices: { speaker_0: 'ru_RU-denis-medium' }, names: {}, mix: {} });
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
    const plan = planReview(config, previous, previous, EMPTY_OVERRIDES, { voices: {}, names: {}, mix: { background_gain_db: -12 } });
    expect(plan.affected).toEqual([]);
    expect(plan.fromStage).toBe('s7');
    // Громкость, равная настройке по умолчанию, — не изменение.
    expect(planReview(config, previous, previous, EMPTY_OVERRIDES, { voices: {}, names: {}, mix: { duck_db: -18 } }).fromStage).toBeNull();
  });
});

describe('FR-5: одноголосый и многоголосый режимы', () => {
  const speakers = {
    speaker_0: { gender: 'м' as const, f0: 120, voicedSeconds: 9 },
    speaker_1: { gender: 'ж' as const, f0: 220, voicedSeconds: 9 },
  };

  it('многоголосый раздаёт голоса по полу', () => {
    const config = parseConfig({ tts: { voice_mode: 'per_speaker', default_voice: 'ru_RU-irina-medium' } }, 'test');
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_0', speakers)).toBe('ru_RU-denis-medium');
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_1', speakers)).toBe('ru_RU-irina-medium');
  });

  it('одноголосый читает всё голосом по умолчанию', () => {
    // Ни автоподбор по полу, ни карта голосов из настроек в этом режиме не в счёт.
    const config = parseConfig(
      { tts: { voice_mode: 'single', default_voice: 'ru_RU-denis-medium', voice_map: { speaker_1: 'ru_RU-dmitri-medium' } } },
      'test',
    );
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_0', speakers)).toBe('ru_RU-denis-medium');
    expect(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_1', speakers)).toBe('ru_RU-denis-medium');
  });

  it('прямой выбор человека действует и в одноголосом режиме', () => {
    const config = parseConfig({ tts: { voice_mode: 'single', default_voice: 'ru_RU-denis-medium' } }, 'test');
    const overrides = { voices: { speaker_1: 'ru_RU-irina-medium' }, names: {}, mix: {} };
    expect(effectiveVoice(config, overrides, 'speaker_1', speakers)).toBe('ru_RU-irina-medium');
    expect(effectiveVoice(config, overrides, 'speaker_0', speakers)).toBe('ru_RU-denis-medium');
  });

  it('смена режима переозвучивает файл', () => {
    // Режим лежит в разделе синтеза, а он целиком входит в ключ кэша стадии.
    const a = parseConfig({ tts: { voice_mode: 'per_speaker' } }, 'test');
    const b = parseConfig({ tts: { voice_mode: 'single' } }, 'test');
    expect(JSON.stringify(stageConfigSlice('s5', a))).not.toBe(JSON.stringify(stageConfigSlice('s5', b)));
  });
});

describe('Имена персонажей', () => {
  it('имя приводится к одной строке и обрезается', () => {
    const parsed = normalizeOverrides({ names: { speaker_0: '  Джек   Райан \n', speaker_1: '   ', speaker_2: 7 } });
    expect(parsed.names).toEqual({ speaker_0: 'Джек Райан' });
  });

  it('очень длинное имя не растянет таблицу', () => {
    const parsed = normalizeOverrides({ names: { speaker_0: 'я'.repeat(200) } });
    expect(parsed.names['speaker_0']).toHaveLength(60);
  });

  it('переименование не требует переозвучки', () => {
    // Имя — подпись в интерфейсе: звук от него не зависит.
    const previous = [makeSegment({ id: 0, start: 0, end: 2, text_en: 'a', text_ru: 'а', speaker: 'speaker_0' })];
    const plan = planReview(
      config,
      previous,
      previous,
      EMPTY_OVERRIDES,
      { voices: {}, names: { speaker_0: 'Джек' }, mix: {} },
    );
    expect(plan.fromStage).toBeNull();
  });
});

describe('§16.4: правка судит по клипу, а не по намерениям', () => {
  it('клип, сделанный голосом из прежних настроек, переозвучивается', () => {
    /*
     * Случай из жизни: в настройках стояла привязка speaker_1 к мужскому
     * голосу, её убрали. Сравнение двух снимков правок отвечало «менять
     * нечего» — в обоих голос один, — а на диске лежал клип, сделанный
     * Дмитрием. Клип подписан тем, из чего сделан, у него и надо спрашивать.
     */
    const stale = makeSegment({
      id: 0,
      start: 0,
      end: 2,
      text_en: 'x',
      text_ru: 'Привет.',
      speaker: 'speaker_0',
      tts_file: '0.wav',
      tts_duration: 0.8,
      tts_key: ttsKey('ru_RU-dmitri-medium', 'Привет.', ''),
      aligned_file: '0a.wav',
    });
    const plan = planReview(config, [stale], [stale], EMPTY_OVERRIDES, EMPTY_OVERRIDES);
    expect(plan.affected).toEqual([0]);
    expect(plan.fromStage).toBe('s5');
  });

  it('клип, сделанный тем же голосом, не трогают', () => {
    const fresh = makeSegment({
      id: 0,
      start: 0,
      end: 2,
      text_en: 'x',
      text_ru: 'Привет.',
      speaker: 'speaker_0',
      tts_file: '0.wav',
      tts_duration: 0.8,
      tts_key: ttsKey(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_0'), 'Привет.', ''),
      aligned_file: '0a.wav',
    });
    expect(planReview(config, [fresh], [fresh], EMPTY_OVERRIDES, EMPTY_OVERRIDES).fromStage).toBeNull();
  });

  it('отпечаток движка входит в проверку', () => {
    const clip = makeSegment({
      id: 0,
      start: 0,
      end: 2,
      text_en: 'x',
      text_ru: 'Привет.',
      speaker: 'speaker_0',
      tts_file: '0.wav',
      tts_duration: 0.8,
      tts_key: ttsKey(effectiveVoice(config, EMPTY_OVERRIDES, 'speaker_0'), 'Привет.', 'piper:22050'),
      aligned_file: '0a.wav',
    });
    // Частота дискретизации сменилась — клип сделан по-старому.
    const plan = planReview(config, [clip], [clip], EMPTY_OVERRIDES, EMPTY_OVERRIDES, {}, 'piper:48000');
    expect(plan.affected).toEqual([0]);
  });
});

describe('голоса от другого движка', () => {
  /**
   * Имена у движков свои и не пересекаются. Общие настройки при смене движка
   * чистит интерфейс, а голоса, назначенные видео в режиме просмотра, живут
   * отдельно и переживают смену — и роняли обе стадии, которые синтезируют:
   * «движок silero не знает голоса ru_RU-denis-medium».
   */
  const known = new Set(['ru_kejilgan', 'ru_ekaterina']);
  const silero = parseConfig(
    { tts: { engine: 'silero', default_voice: 'ru_kejilgan', voice_map: { speaker_1: 'ru_ekaterina', speaker_2: 'ru_RU-irina-medium' } } },
    'тест',
  );

  it('чужие имена уходят, свои остаются', () => {
    const result = withKnownVoices(silero, { voices: { speaker_0: 'ru_RU-denis-medium' }, names: {}, mix: {} }, known);
    expect(result.config.tts.voice_map).toEqual({ speaker_1: 'ru_ekaterina' });
    expect(result.overrides.voices).toEqual({});
    expect(result.dropped).toEqual([
      { speaker: 'speaker_2', voice: 'ru_RU-irina-medium', source: 'настройки' },
      { speaker: 'speaker_0', voice: 'ru_RU-denis-medium', source: 'правки видео' },
    ]);
  });

  it('пустой список известных ничего не трогает', () => {
    // Список не удалось получить — лучше внятная ошибка движка, чем подмена.
    const overrides = { voices: { speaker_0: 'ru_RU-denis-medium' }, names: {}, mix: {} };
    const result = withKnownVoices(silero, overrides, new Set());
    expect(result.overrides.voices).toEqual({ speaker_0: 'ru_RU-denis-medium' });
    expect(result.dropped).toEqual([]);
  });

  it('после отбора голос выбирается по полу, а не по чужому имени', () => {
    const speakers = { speaker_0: { gender: 'ж' as const, f0: 292, voicedSeconds: 11 } };
    const result = withKnownVoices(silero, { voices: { speaker_0: 'ru_RU-denis-medium' }, names: {}, mix: {} }, known);
    const applied = applyOverrides(result.config, result.overrides, speakers);
    expect(applied.tts.voice_map['speaker_0']).not.toBe('ru_RU-denis-medium');
  });
});
