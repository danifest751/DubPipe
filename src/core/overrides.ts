import type { DubConfig } from '../config/schema.js';
import { RUSSIAN_VOICES, type VoiceInfo } from '../providers/tts/voices.js';
import type { SpeakerProfile } from '../providers/diarization/gender.js';
import type { Segment } from './types.js';

export type SpeakerProfiles = Record<string, SpeakerProfile>;

/**
 * Правки одного видео поверх общих настроек (ТЗ §16.4, режим просмотра).
 *
 * Человек смотрит готовый файл и видит: мужчина говорит женским голосом,
 * оригинал слишком громкий. Такие правки относятся к этому видео, а не ко всем,
 * поэтому живут в рабочем каталоге (`overrides.json`), а не в config.yaml.
 * Стадии S5–S7 читают их и накладывают на конфигурацию перед работой.
 */

export interface MixOverrides {
  background_gain_db?: number;
  voice_gain_db?: number;
  duck_db?: number;
}

export interface ProjectOverrides {
  /** Голос на спикера для этого видео; перекрывает tts.voice_map. */
  voices: Record<string, string>;
  /**
   * Имя персонажа вместо `speaker_0`.
   *
   * Диаризация даёт номера, а смотрящий имеет дело с людьми: разобрав, кто
   * есть кто, он подписывает голос один раз, и дальше в репликах видно «Джек»,
   * а не «speaker_2». На озвучку это не влияет — только на то, читаемо ли то,
   * что человек правит.
   */
  names: Record<string, string>;
  mix: MixOverrides;
}

export const EMPTY_OVERRIDES: ProjectOverrides = { voices: {}, names: {}, mix: {} };

export function normalizeOverrides(raw: unknown): ProjectOverrides {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProjectOverrides>;
  const voices: Record<string, string> = {};
  for (const [speaker, voice] of Object.entries(source.voices ?? {})) {
    if (typeof voice === 'string' && voice.trim()) voices[speaker] = voice.trim();
  }
  const names: Record<string, string> = {};
  for (const [speaker, name] of Object.entries(source.names ?? {})) {
    // Имя — подпись в интерфейсе, а не путь и не команда: длину ограничиваем,
    // переводы строк убираем.
    if (typeof name === 'string' && name.trim()) names[speaker] = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  }
  const mix: MixOverrides = {};
  const mixSource = (source.mix ?? {}) as Record<string, unknown>;
  for (const key of ['background_gain_db', 'voice_gain_db', 'duck_db'] as const) {
    const value = mixSource[key];
    if (typeof value === 'number' && Number.isFinite(value)) mix[key] = value;
  }
  return { voices, names, mix };
}

/**
 * Голоса по полу: спикер, которому голос не назначен ни в настройках, ни в правках,
 * получает голос своего пола (ТЗ FR-5, [2.3]). Спикеры одного пола разбираются по
 * кругу — чтобы двое мужчин не звучали одинаково, пока есть разные голоса.
 * Голос по умолчанию идёт первым, если его пол подходит: он уже загружен.
 */
export function autoVoiceMap(
  speakers: SpeakerProfiles,
  config: DubConfig,
  voices: VoiceInfo[] = RUSSIAN_VOICES,
): Record<string, string> {
  const result: Record<string, string> = {};
  const counters: Record<string, number> = {};
  const ordered = Object.keys(speakers).sort((a, b) => {
    const numeric = (name: string) => Number(/(\d+)$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
    return numeric(a) - numeric(b) || a.localeCompare(b);
  });
  for (const speaker of ordered) {
    if (config.tts.voice_map[speaker]) continue;
    const gender = speakers[speaker]?.gender;
    if (gender !== 'м' && gender !== 'ж') continue;
    const pool = voices.filter((voice) => voice.gender === gender);
    if (pool.length === 0) continue;
    const preferred = pool.findIndex((voice) => voice.name === config.tts.default_voice);
    const rotated = preferred > 0 ? [...pool.slice(preferred), ...pool.slice(0, preferred)] : pool;
    const index = counters[gender] ?? 0;
    counters[gender] = index + 1;
    result[speaker] = rotated[index % rotated.length]!.name;
  }
  return result;
}

/**
 * Итоговая карта голосов: автоподбор по полу, поверх — настройки, поверх —
 * правки этого видео.
 *
 * В одноголосом режиме карта пуста: всё читает `default_voice`. Правки видео
 * действуют и там — это прямой выбор человека для конкретного говорящего, а
 * не догадка программы.
 */
export function voiceMapFor(
  config: DubConfig,
  overrides: ProjectOverrides,
  speakers: SpeakerProfiles,
): Record<string, string> {
  if (config.tts.voice_mode === 'single') return { ...overrides.voices };
  return { ...autoVoiceMap(speakers, config), ...config.tts.voice_map, ...overrides.voices };
}

/** Конфигурация с наложенными правками видео и голосами по полу. */
export function applyOverrides(config: DubConfig, overrides: ProjectOverrides, speakers: SpeakerProfiles = {}): DubConfig {
  return {
    ...config,
    tts: { ...config.tts, voice_map: voiceMapFor(config, overrides, speakers) },
    mix: { ...config.mix, ...overrides.mix },
  };
}

export function effectiveVoice(
  config: DubConfig,
  overrides: ProjectOverrides,
  speaker: string,
  speakers: SpeakerProfiles = {},
): string {
  return (
    overrides.voices[speaker] ??
    (config.tts.voice_mode === 'single' ? undefined : config.tts.voice_map[speaker]) ??
    (config.tts.voice_mode === 'single' ? undefined : autoVoiceMap(speakers, config)[speaker]) ??
    config.tts.default_voice
  );
}

export interface ReviewPlan {
  segments: Segment[];
  /** id реплик, которым нужен новый синтез. */
  affected: number[];
  /** С какой стадии перезапускать: синтез, только сведение или ничего не менялось. */
  fromStage: 's5' | 's7' | null;
}

/**
 * Сравнивает правки с тем, что уже озвучено, и снимает синтез с реплик, у которых
 * сменился текст, спикер или голос спикера — S5 пересинтезирует только их.
 * Если менялись лишь громкости, достаточно пересвести (S7).
 */
export function planReview(
  config: DubConfig,
  previous: Segment[],
  next: Segment[],
  previousOverrides: ProjectOverrides,
  nextOverrides: ProjectOverrides,
  speakers: SpeakerProfiles = {},
): ReviewPlan {
  const before = new Map(previous.map((segment) => [segment.id, segment]));
  const affected: number[] = [];
  const segments = next.map((segment) => {
    const old = before.get(segment.id);
    const voiceBefore = old ? effectiveVoice(config, previousOverrides, old.speaker, speakers) : null;
    const voiceAfter = effectiveVoice(config, nextOverrides, segment.speaker, speakers);
    // Смена спикера сама по себе синтеза не требует — только если у нового спикера другой голос.
    const changed = !old || (old.text_ru ?? '') !== (segment.text_ru ?? '') || voiceBefore !== voiceAfter;
    if (!changed) return segment;
    affected.push(segment.id);
    return {
      ...segment,
      tts_file: null,
      tts_duration: null,
      tts_key: null,
      aligned_file: null,
      aligned_duration: null,
      tempo: null,
      shift_ms: null,
    };
  });

  const mixChanged = (['background_gain_db', 'voice_gain_db', 'duck_db'] as const).some(
    (key) => (previousOverrides.mix[key] ?? config.mix[key]) !== (nextOverrides.mix[key] ?? config.mix[key]),
  );
  const fromStage = affected.length > 0 ? 's5' : mixChanged ? 's7' : null;
  return { segments, affected, fromStage };
}
