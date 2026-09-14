/** Shared data contracts between stages (SPEC §5). */

export const STAGE_IDS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const STAGE_TITLES: Record<StageId, string> = {
  s1: 'Приём входа и извлечение аудио',
  s2: 'Распознавание речи',
  s3: 'Перевод EN→RU',
  s4: 'Отделение голоса от фона',
  s5: 'Синтез русской речи',
  s6: 'Подгонка по таймкодам',
  s7: 'Сведение и мультиплексирование',
};

/** Stages that cannot be switched off (SPEC §2). */
export const MANDATORY_STAGES: readonly StageId[] = ['s1', 's2', 's3', 's5', 's7'];

export type SegmentFlag =
  | 'translation_failed'
  | 'profanity'
  | 'truncated'
  | 'no_speech'
  | 'force_split';

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/** SPEC §5.1 */
export interface Segment {
  id: number;
  start: number;
  end: number;
  speaker: string;
  text_en: string;
  text_ru: string | null;
  tts_file: string | null;
  tts_duration: number | null;
  tempo: number | null;
  aligned_file: string | null;
  words: WordTiming[] | null;
  overlap: boolean;
  shift_ms: number | null;
  retranslate_count: number;
  flags: SegmentFlag[];
}

/** SPEC §5.2 */
export interface Meta {
  input: string;
  input_hash: string;
  duration_seconds: number;
  created_at: string;
  tool_version: string;
  has_video: boolean;
  stage_fingerprints: Partial<Record<StageId, string>>;
  /** Куда лёг готовый дубляж в последний раз: интерфейс открывает его на просмотр. */
  output?: string | null;
  /** Записанные файлы субтитров: код языка и что это — оригинал или перевод. */
  subtitles?: Array<{ lang: string; kind?: 'source' | 'target'; path: string }>;
}

export interface StageOutcome {
  stage: StageId;
  cached: boolean;
  provider: string;
  warnings: string[];
  durationMs: number;
}

export function makeSegment(init: Partial<Segment> & Pick<Segment, 'id' | 'start' | 'end' | 'text_en'>): Segment {
  return {
    speaker: 'speaker_0',
    text_ru: null,
    tts_file: null,
    tts_duration: null,
    tempo: null,
    aligned_file: null,
    words: null,
    overlap: false,
    shift_ms: null,
    retranslate_count: 0,
    flags: [],
    ...init,
  };
}

export function slotOf(segment: Pick<Segment, 'start' | 'end'>): number {
  return segment.end - segment.start;
}
