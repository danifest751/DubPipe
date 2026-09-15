import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { configSchema } from '../src/config/schema.js';
import { ACCENT_SLACK_HZ, autoVoiceMap } from '../src/core/overrides.js';
import {
  SILERO_CIS,
  SILERO_DEFAULT_VOICE,
  SILERO_MODELS,
  SILERO_NATIVE,
  SILERO_VOICES,
  sileroModelFor,
} from '../src/providers/tts/silero-voices.js';
import { voicesForEngine, RUSSIAN_VOICES } from '../src/providers/tts/voices.js';
import { FEMALE_QUARTILE_MIN_HZ, MALE_QUARTILE_MAX_HZ } from '../src/providers/diarization/gender.js';

const silero = parseConfig({ tts: { engine: 'silero', default_voice: 'ru_zhadyra' } }, 'тест');

describe('голоса silero', () => {
  it('каталог движка не смешивается с чужим', () => {
    expect(voicesForEngine('silero')).toBe(SILERO_VOICES);
    expect(voicesForEngine('piper')).toBe(RUSSIAN_VOICES);
  });

  it('пол голоса не спорит с его же замеренным тоном', () => {
    for (const voice of SILERO_VOICES) {
      expect(typeof voice.f0, `${voice.name} без замера тона`).toBe('number');
      if (voice.gender === 'м') expect(voice.f0!, voice.name).toBeLessThan(MALE_QUARTILE_MAX_HZ + 10);
      if (voice.gender === 'ж') expect(voice.f0!, voice.name).toBeGreaterThan(FEMALE_QUARTILE_MIN_HZ + 15);
    }
  });

  it('у каждого голоса есть модель, и имена не спорят между моделями', () => {
    // Диктор живёт ровно в одной модели: по имени голоса движок решает, какую
    // качать и поднимать. Совпади имена — фильм озвучился бы не тем голосом.
    const names = SILERO_VOICES.map((voice) => voice.name);
    expect(new Set(names).size).toBe(names.length);
    for (const voice of SILERO_VOICES) expect(sileroModelFor(voice.name), voice.name).not.toBeNull();
    expect(sileroModelFor('ru_RU-irina-medium')).toBeNull();
    expect(SILERO_MODELS.map((model) => model.name)).toEqual(['v5_5_ru', 'v5_cis_base']);
  });

  it('носители помечены как носители, дикторы СНГ — как акцент', () => {
    // По этой пометке автоподбор и раздаёт главные роли; спутай её — и акцент
    // вернётся туда, откуда его убирали.
    for (const voice of SILERO_NATIVE.voices) expect(voice.accent, voice.name).toBe(false);
    for (const voice of SILERO_CIS.voices) expect(voice.accent, voice.name).toBe(true);
    expect(SILERO_NATIVE.voices).toHaveLength(5);
    expect(SILERO_CIS.voices).toHaveLength(29);
  });

  it('движку нельзя подсунуть имя голоса из каталога piper', () => {
    const bad = configSchema.safeParse({ tts: { engine: 'silero', default_voice: 'ru_RU-irina-medium' } });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]!.path).toEqual(['tts', 'default_voice']);
      expect(bad.error.issues[0]!.message).toContain(SILERO_DEFAULT_VOICE);
    }
  });
});

/**
 * Ради этого движок и появился: у piper один русский женский голос, и две
 * героини звучали одинаково. Проверяется не «выдали два разных имени», а что
 * выданное близко к тому, как звучит сама актриса.
 */
describe('подбор голоса по тону', () => {
  const f0Of = (name: string) => SILERO_VOICES.find((voice) => voice.name === name)!.f0!;

  // Профили пятого эпизода, замеренные на записи.
  const profiles = {
    speaker_0: { gender: 'м' as const, f0: 110, voicedSeconds: 14.7, p25: 97, p75: 123 },
    speaker_1: { gender: 'ж' as const, f0: 195, voicedSeconds: 7.0, p25: 181, p75: 217 },
    speaker_2: { gender: 'ж' as const, f0: 176, voicedSeconds: 7.4, p25: 164, p75: 223 },
  };

  it('каждому говорящему достаётся голос его высоты', () => {
    const map = autoVoiceMap(profiles, silero);
    // Точность — с точностью до уступки носителю: акцент слышно сразу, а
    // разницу в два десятка герц — нет.
    expect(Math.abs(f0Of(map['speaker_0']!) - 110)).toBeLessThanOrEqual(ACCENT_SLACK_HZ);
    expect(Math.abs(f0Of(map['speaker_1']!) - 195)).toBeLessThanOrEqual(ACCENT_SLACK_HZ);
    expect(Math.abs(f0Of(map['speaker_2']!) - 176)).toBeLessThanOrEqual(ACCENT_SLACK_HZ);
  });

  it('носитель выигрывает у диктора с акцентом, если разница по тону невелика', () => {
    // На 110 Гц есть точное попадание — ru_kejilgan, но он читает с акцентом,
    // а носитель ru_eugene стоит в семи герцах. Семь герц не слышно, акцент —
    // слышно с первой фразы.
    const map = autoVoiceMap({ speaker_0: { gender: 'м', f0: 110, voicedSeconds: 14.7 } }, silero);
    expect(map['speaker_0']).toBe('ru_eugene');
  });

  it('но далёкий носитель уступает близкому диктору с акцентом', () => {
    // Героиню в 176 Гц отдать носителю значит отдать её голосу за 240 Гц:
    // ближе носителей нет, они заняты. Это уже не «чуть выше», а чужой голос.
    const map = autoVoiceMap(
      {
        speaker_0: { gender: 'ж', f0: 198, voicedSeconds: 7 },
        speaker_1: { gender: 'ж', f0: 176, voicedSeconds: 7 },
      },
      silero,
    );
    expect(map['speaker_0']).toBe('ru_xenia');
    expect(map['speaker_1']).toBe('ru_ramilia');
  });

  it('две героини получают разные голоса', () => {
    const map = autoVoiceMap(profiles, silero);
    expect(map['speaker_1']).not.toBe(map['speaker_2']);
  });

  it('голос, уже занятый вручную, второй раз не выдаётся', () => {
    const pinned = parseConfig(
      { tts: { engine: 'silero', default_voice: 'ru_zhadyra', voice_map: { speaker_1: 'ru_ramilia' } } },
      'тест',
    );
    const map = autoVoiceMap(profiles, pinned);
    // speaker_2 ближе всего к ru_ramilia, но её уже отдали руками — берётся следующая по высоте.
    expect(map['speaker_2']).not.toBe('ru_ramilia');
    expect(map['speaker_1']).toBeUndefined();
  });

  it('говорящие рядом по тону всё равно расходятся по голосам', () => {
    const close = {
      speaker_0: { gender: 'ж' as const, f0: 196, voicedSeconds: 6 },
      speaker_1: { gender: 'ж' as const, f0: 197, voicedSeconds: 6 },
      speaker_2: { gender: 'ж' as const, f0: 198, voicedSeconds: 6 },
    };
    const map = autoVoiceMap(close, silero);
    expect(new Set(Object.values(map)).size).toBe(3);
  });

  it('без замера тона у говорящего подбор возвращается к раздаче по кругу', () => {
    const unmeasured = {
      speaker_0: { gender: 'ж' as const, f0: null, voicedSeconds: 6 },
      speaker_1: { gender: 'ж' as const, f0: null, voicedSeconds: 6 },
    };
    const map = autoVoiceMap(unmeasured, silero);
    expect(map['speaker_0']).toBe('ru_zhadyra'); // голос по умолчанию идёт первым
    expect(map['speaker_1']).not.toBe(map['speaker_0']);
  });

  it('голоса на границе диапазонов автоподбор не раздаёт', () => {
    const borderline = SILERO_VOICES.filter((voice) => voice.gender === '—').map((voice) => voice.name);
    const map = autoVoiceMap(profiles, silero);
    for (const name of Object.values(map)) expect(borderline).not.toContain(name);
  });
});
