import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { configSchema } from '../src/config/schema.js';
import { autoVoiceMap } from '../src/core/overrides.js';
import { SILERO_VOICES } from '../src/providers/tts/silero-voices.js';
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

  it('движку нельзя подсунуть имя голоса из каталога piper', () => {
    const bad = configSchema.safeParse({ tts: { engine: 'silero', default_voice: 'ru_RU-irina-medium' } });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]!.path).toEqual(['tts', 'default_voice']);
      expect(bad.error.issues[0]!.message).toContain('ru_zhadyra');
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
    expect(Math.abs(f0Of(map['speaker_0']!) - 110)).toBeLessThanOrEqual(5);
    expect(Math.abs(f0Of(map['speaker_1']!) - 195)).toBeLessThanOrEqual(5);
    expect(Math.abs(f0Of(map['speaker_2']!) - 176)).toBeLessThanOrEqual(5);
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
