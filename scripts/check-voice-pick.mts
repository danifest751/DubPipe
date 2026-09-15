/** Кому какой голос достаётся после того, как в каталог вошли носители. */
import { parseConfig } from '../src/config/load.js';
import { autoVoiceMap } from '../src/core/overrides.js';
import { SILERO_VOICES } from '../src/providers/tts/silero-voices.js';

const config = parseConfig({ tts: { engine: 'silero', default_voice: 'ru_xenia' } }, 'проба');
const profiles = {
  speaker_0: { gender: 'м' as const, f0: 110, voicedSeconds: 14.7 },
  speaker_1: { gender: 'ж' as const, f0: 195, voicedSeconds: 7 },
  speaker_2: { gender: 'ж' as const, f0: 176, voicedSeconds: 7.4 },
  speaker_3: { gender: 'м' as const, f0: 152, voicedSeconds: 5 },
  speaker_4: { gender: 'ж' as const, f0: 230, voicedSeconds: 5 },
  speaker_5: { gender: 'ж' as const, f0: 205, voicedSeconds: 5 },
};
const map = autoVoiceMap(profiles, config);
for (const [speaker, profile] of Object.entries(profiles)) {
  const voice = SILERO_VOICES.find((item) => item.name === map[speaker]);
  console.log(
    `${speaker} ${String(profile.f0).padStart(3)} Гц -> ${(voice?.name ?? '—').padEnd(14)} ${String(voice?.f0 ?? '').padStart(3)} Гц  ${voice?.accent ? 'с акцентом' : 'носитель'}`,
  );
}
