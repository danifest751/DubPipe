import type { VoiceInfo } from './voices.js';

/**
 * Дикторы silero: две модели, 34 русских голоса.
 *
 * Началось всё с `v5_cis_base` — 29 голосов в одной модели на 92 МБ. Ради них
 * движок и брали: у piper русский женский голос ровно один, и две героини в
 * фильме звучат одинаково. Но это дикторы народов СНГ, читающие по-русски, и у
 * части из них слышен акцент — в дубляже он выдаёт себя сразу.
 *
 * Поэтому рядом стоит `v5_5_ru`: пятеро носителей, акцента нет вовсе. Их мало,
 * и на многолюдный фильм одних их не хватит, зато главные роли достаются им —
 * автоподбор берёт их первыми, а к дикторам с акцентом спускается, только когда
 * свободных носителей нужного пола не осталось.
 *
 * Тон замерен нашим же определителем (`profileSpeakers`, тот самый, которым
 * меряются актёры в записи): каждому диктору дали прочесть по несколько реплик,
 * 10–15 секунд звонкой речи на голос. Числа — медиана; по ним и подбирается
 * пара актёру. Мерка повторяется скриптом `scripts/voice-pitch.mts`.
 *
 * Пол проставлен приговором того же определителя. У двоих он отказался
 * отвечать — 167 и 169 Гц приходятся ровно на полосу, где мужской и женский
 * диапазоны сходятся; они помечены «—» и в автоподбор не попадают, но выбрать
 * их руками никто не мешает.
 */

export interface SileroModel {
  /** Имя файла модели и её тег в мосту. */
  name: string;
  url: string;
  /** Меньше — значит скачалось не то: страница ошибки вместо модели. */
  minBytes: number;
  /**
   * Как в модели зовут дикторов.
   *
   * В `v5_cis_base` рядом с русскими живут башкирские, татарские, эрзянские —
   * те читают на своих языках, и русскому дубляжу не годятся; из неё берутся
   * только имена с приставкой `ru_`. В `v5_5_ru` дикторов пятеро и приставки у
   * них нет — её добавляем, чтобы имена голосов по всему проекту были одного
   * вида.
   */
  naming: 'ru' | 'prefix';
  voices: VoiceInfo[];
}

function voice(model: string, name: string, f0: number, gender: VoiceInfo['gender'], note: string, accent: boolean): VoiceInfo {
  return {
    name,
    language: 'ru_RU',
    speaker: name.replace(/^ru_/, ''),
    quality: model,
    gender,
    note,
    f0,
    accent,
  };
}

/** Носители: акцента нет, но их всего пятеро. По возрастанию тона. */
export const SILERO_NATIVE: SileroModel = {
  name: 'v5_5_ru',
  url: 'https://models.silero.ai/models/tts/ru/v5_5_ru.pt',
  minBytes: 100_000_000,
  naming: 'prefix',
  voices: [
    voice('v5_5_ru', 'ru_eugene', 103, 'м', 'носитель, самый низкий мужской', false),
    voice('v5_5_ru', 'ru_aidar', 124, 'м', 'носитель, ровный мужской', false),
    voice('v5_5_ru', 'ru_xenia', 198, 'ж', 'носитель, низкий женский', false),
    voice('v5_5_ru', 'ru_baya', 242, 'ж', 'носитель, высокий женский', false),
    voice('v5_5_ru', 'ru_kseniya', 242, 'ж', 'носитель, высокий женский', false),
  ],
};

/** Дикторы народов СНГ: голосов много, но у части слышен акцент. */
export const SILERO_CIS: SileroModel = {
  name: 'v5_cis_base',
  url: 'https://models.silero.ai/models/tts/ru/v5_cis_base.pt',
  minBytes: 50_000_000,
  naming: 'ru',
  voices: [
    voice('v5_cis_base', 'ru_safarhuja', 104, 'м', 'самый низкий мужской', true),
    voice('v5_cis_base', 'ru_kejilgan', 110, 'м', '', true),
    voice('v5_cis_base', 'ru_roman', 110, 'м', '', true),
    voice('v5_cis_base', 'ru_miyau', 111, 'м', '', true),
    voice('v5_cis_base', 'ru_alexandr', 116, 'м', '', true),
    voice('v5_cis_base', 'ru_bogdan', 120, 'м', '', true),
    voice('v5_cis_base', 'ru_eduard', 122, 'м', '', true),
    voice('v5_cis_base', 'ru_dmitriy', 126, 'м', '', true),
    voice('v5_cis_base', 'ru_marat', 136, 'м', '', true),
    voice('v5_cis_base', 'ru_gamat', 152, 'м', 'высокий мужской', true),
    voice('v5_cis_base', 'ru_sibday', 155, 'м', 'высокий мужской', true),
    voice('v5_cis_base', 'ru_albina', 167, '—', 'на границе диапазонов, автоподбор её не берёт', true),
    voice('v5_cis_base', 'ru_igor', 169, '—', 'на границе диапазонов, автоподбор его не берёт', true),
    voice('v5_cis_base', 'ru_ramilia', 177, 'ж', 'низкий женский', true),
    voice('v5_cis_base', 'ru_zinaida', 179, 'ж', 'низкий женский', true),
    voice('v5_cis_base', 'ru_vika', 188, 'ж', '', true),
    voice('v5_cis_base', 'ru_nurgul', 192, 'ж', '', true),
    voice('v5_cis_base', 'ru_zhadyra', 195, 'ж', '', true),
    voice('v5_cis_base', 'ru_aigul', 197, 'ж', '', true),
    voice('v5_cis_base', 'ru_saida', 199, 'ж', '', true),
    voice('v5_cis_base', 'ru_alfia', 202, 'ж', '', true),
    voice('v5_cis_base', 'ru_zara', 204, 'ж', '', true),
    voice('v5_cis_base', 'ru_kermen', 214, 'ж', '', true),
    voice('v5_cis_base', 'ru_alfia2', 222, 'ж', '', true),
    voice('v5_cis_base', 'ru_onaoy', 223, 'ж', '', true),
    voice('v5_cis_base', 'ru_oksana', 225, 'ж', '', true),
    voice('v5_cis_base', 'ru_zhazira', 225, 'ж', '', true),
    voice('v5_cis_base', 'ru_karina', 227, 'ж', 'высокий женский', true),
    voice('v5_cis_base', 'ru_ekaterina', 237, 'ж', 'самый высокий женский', true),
  ],
};

export const SILERO_MODELS: SileroModel[] = [SILERO_NATIVE, SILERO_CIS];

/** Весь каталог движка, по возрастанию тона: так видно, из чего идёт выбор. */
export const SILERO_VOICES: VoiceInfo[] = SILERO_MODELS.flatMap((model) => model.voices).sort(
  (a, b) => (a.f0 ?? 0) - (b.f0 ?? 0) || a.name.localeCompare(b.name),
);

/** Голос по умолчанию: носитель, середина женского диапазона. */
export const SILERO_DEFAULT_VOICE = 'ru_xenia';

/** В какой модели живёт этот диктор; `null` — движок такого не знает. */
export function sileroModelFor(voice: string): SileroModel | null {
  return SILERO_MODELS.find((model) => model.voices.some((item) => item.name === voice)) ?? null;
}
