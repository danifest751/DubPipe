import type { VoiceInfo } from './voices.js';

/**
 * Дикторы silero `v5_cis_base` — 29 русских голосов в одной модели на 92 МБ.
 *
 * Ради них всё и затевалось: у piper русский женский голос ровно один, и две
 * героини в фильме звучат одинаково. Здесь женских шестнадцать, и они
 * расходятся по высоте от 177 до 237 Гц — героине можно дать не «женский голос
 * вообще», а тот, что ближе к её собственному.
 *
 * Тон замерен нашим же определителем (`profileSpeakers`, тот самый, которым
 * меряются актёры в записи): каждому диктору дали прочесть четыре реплики из
 * пятого эпизода, 10–15 секунд звонкой речи на голос. Числа — медиана; по ним
 * и подбирается пара актёру. Мерка повторяется скриптом `scripts/voice-pitch.mts`.
 *
 * Пол проставлен приговором того же определителя. У двоих он отказался
 * отвечать — 167 и 169 Гц приходятся ровно на полосу, где мужской и женский
 * диапазоны сходятся; они помечены «—» и в автоподбор не попадают, но выбрать
 * их руками никто не мешает.
 *
 * Оговорка, которую слышно: это дикторы народов СНГ, читающие по-русски, и у
 * части из них есть акцент.
 */

const RATE_NOTE = 'silero v5_cis_base';

function voice(name: string, f0: number, gender: VoiceInfo['gender'], note: string): VoiceInfo {
  return {
    name,
    language: 'ru_RU',
    speaker: name.replace(/^ru_/, ''),
    quality: 'v5_cis_base',
    gender,
    note: note || RATE_NOTE,
    f0,
  };
}

/** По возрастанию тона: так видно, из чего выбирает автоподбор. */
export const SILERO_VOICES: VoiceInfo[] = [
  voice('ru_safarhuja', 104, 'м', 'самый низкий мужской'),
  voice('ru_kejilgan', 110, 'м', ''),
  voice('ru_roman', 110, 'м', ''),
  voice('ru_miyau', 111, 'м', ''),
  voice('ru_alexandr', 116, 'м', ''),
  voice('ru_bogdan', 120, 'м', ''),
  voice('ru_eduard', 122, 'м', ''),
  voice('ru_dmitriy', 126, 'м', ''),
  voice('ru_marat', 136, 'м', ''),
  voice('ru_gamat', 152, 'м', 'высокий мужской'),
  voice('ru_sibday', 155, 'м', 'высокий мужской'),
  voice('ru_albina', 167, '—', 'на границе диапазонов, автоподбор её не берёт'),
  voice('ru_igor', 169, '—', 'на границе диапазонов, автоподбор его не берёт'),
  voice('ru_ramilia', 177, 'ж', 'низкий женский'),
  voice('ru_zinaida', 179, 'ж', 'низкий женский'),
  voice('ru_vika', 188, 'ж', ''),
  voice('ru_nurgul', 192, 'ж', ''),
  voice('ru_zhadyra', 195, 'ж', ''),
  voice('ru_aigul', 197, 'ж', ''),
  voice('ru_saida', 199, 'ж', ''),
  voice('ru_alfia', 202, 'ж', ''),
  voice('ru_zara', 204, 'ж', ''),
  voice('ru_kermen', 214, 'ж', ''),
  voice('ru_alfia2', 222, 'ж', ''),
  voice('ru_onaoy', 223, 'ж', ''),
  voice('ru_oksana', 225, 'ж', ''),
  voice('ru_zhazira', 225, 'ж', ''),
  voice('ru_karina', 227, 'ж', 'высокий женский'),
  voice('ru_ekaterina', 237, 'ж', 'самый высокий женский'),
];

/** Голос по умолчанию для движка: середина женского диапазона. */
export const SILERO_DEFAULT_VOICE = 'ru_zhadyra';

/** Модель, в которой эти дикторы живут. Одна на все 29 голосов. */
export const SILERO_MODEL = {
  name: 'v5_cis_base',
  url: 'https://models.silero.ai/models/tts/ru/v5_cis_base.pt',
  /** Меньше — значит скачалось не то: страница ошибки вместо модели. */
  minBytes: 50_000_000,
} as const;
