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
  | 'force_split'
  /**
   * Тон самой реплики спорит с полом её говорящего: скорее всего, диаризация
   * отдала короткую фразу соседу по сцене. Машина здесь не вправе решать за
   * человека — она лишь показывает, какую строку стоит переслушать.
   */
  | 'speaker_doubt';

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
  /**
   * Чем и из чего озвучена реплика: голос и текст.
   *
   * Без этого повторный запуск стадии переиспользовал готовый файл по одному
   * его существованию — и смена голоса не меняла ничего, потому что файлы были
   * на месте.
   */
  tts_key: string | null;
  tempo: number | null;
  aligned_file: string | null;
  /**
   * Длительность уложенного клипа — после ускорения и обрезки.
   *
   * Отдельным полем, потому что вопросов два, а ответ раньше был один.
   * `tts_duration` — сколько наговорил синтезатор: из неё укладка считает темп,
   * а S5 выводит скорость речи голоса. `aligned_duration` — сколько звучит то,
   * что ляжет в дорожку: её спрашивают сведение и субтитры. Пока обе величины
   * жили в одном поле, укладка затирала первую второй и на следующем прогоне
   * считала темп от уже ускоренного клипа: выходил темп 1.0, реплика ложилась
   * неускоренной и наезжала на соседнюю.
   */
  aligned_duration: number | null;
  words: WordTiming[] | null;
  overlap: boolean;
  shift_ms: number | null;
  retranslate_count: number;
  flags: SegmentFlag[];
  /**
   * Перевод, разделённый на фразы по ритму оригинала: куски озвучиваются
   * порознь и склеиваются паузами говорящего. Заполняет S3, читает S5.
   *
   * Отдельным полем, а не разметкой внутри `text_ru`: текст уходит ещё и в
   * субтитры, и в правки человека, и никакие служебные знаки ему там не нужны.
   */
  phrases?: string[] | null;
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
  /**
   * Файл, из которого собран этот прогон.
   *
   * Для ссылки `input` — это сама ссылка, а скачанное лежит в рабочей папке под
   * своим именем. Без этого поля S7 искал бы источник по `input`, то есть по
   * URL, и дубляж по ссылке падал бы на сведении. Путь записывает S1 — она
   * единственная знает, откуда взялся файл.
   */
  source_path?: string;
  /** Куда лёг готовый дубляж в последний раз: интерфейс открывает его на просмотр. */
  output?: string | null;
  /** Записанные файлы субтитров: код языка и что это — оригинал или перевод. */
  subtitles?: Array<{ lang: string; kind?: 'source' | 'target'; path: string }>;
  /**
   * Сколько уже потрачено на перевод этого файла, в долларах, за все прогоны.
   *
   * Стоимость сообщалась одной строкой лога и исчезала. Между дешёвой и сильной
   * моделью разница на серии — от 1.7 цента до 70, и человек не видел ни того,
   * во что обойдётся запуск, ни того, во что он уже обошёлся.
   */
  translation_cost_usd?: number;
}

/**
 * Предупреждение прогона: русский текст плюс ключ словаря для интерфейса.
 *
 * Ход стадий интерфейс переводит по ключам (`Phrase` в logger.ts), а
 * предупреждения оставались русскими на английском экране — двадцать четыре
 * места собирали готовую фразу и отдавали её как есть. Русский текст здесь
 * остаётся: им пользуется консоль, он же запасной вариант для ключа, которого
 * страница не знает.
 */
export interface WarningPhrase {
  key: string;
  ru: string;
  params?: Record<string, string | number>;
  /**
   * Какая стадия предупредила. Проставляет конвейер, а не сама стадия: ей
   * незачем знать своё имя. Раньше приставка `[s3]` приклеивалась прямо к
   * тексту, и после перевода предупреждений на ключи это давало в консоли
   * «[s3] [object Object]».
   */
  stage?: string;
}

export type StageWarning = string | WarningPhrase;

/** Короткая запись: `warn('warn.noVideo', 'Во входе нет видеопотока…')`. */
export function warn(key: string, ru: string, params?: Record<string, string | number>): WarningPhrase {
  return params === undefined ? { key, ru } : { key, ru, params };
}

/** Текст предупреждения по-русски — для консоли и для журнала прогона. */
export function warningText(warning: StageWarning): string {
  return typeof warning === 'string' ? warning : warning.ru;
}

export interface StageOutcome {
  stage: StageId;
  cached: boolean;
  provider: string;
  warnings: StageWarning[];
  durationMs: number;
}

export function makeSegment(init: Partial<Segment> & Pick<Segment, 'id' | 'start' | 'end' | 'text_en'>): Segment {
  return {
    speaker: 'speaker_0',
    text_ru: null,
    tts_file: null,
    tts_duration: null,
    tts_key: null,
    tempo: null,
    aligned_file: null,
    aligned_duration: null,
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

/**
 * Сколько времени на самом деле отведено реплике: её собственный слот плюс
 * тишина после неё, которую можно занять.
 *
 * Пауза между репликами — такое же место для речи: там всё равно молчат.
 * Стадия укладки это уже использует, а стадия перевода раньше не знала и
 * заказывала перевод по одному слоту. На редком на диалог материале это
 * доходило до нелепости: слот 0.5 с при надбавке 0.7 с давал отрицательное
 * число знаков, и у модели просили перевести реплику одной буквой.
 *
 * Занимается не вся пауза, а ограниченная часть: иначе перед долгим молчанием
 * реплика растянулась бы на всю его длину и уехала от картинки.
 */
export function availableSeconds(
  segments: Pick<Segment, 'start' | 'end'>[],
  index: number,
  options: { borrowSeconds: number; gapSeconds: number },
): number {
  const segment = segments[index];
  if (!segment) return 0;
  const slot = slotOf(segment);
  const next = segments[index + 1];
  const limit = next ? next.start - options.gapSeconds : segment.end + options.borrowSeconds;
  const room = Math.max(0, Math.min(options.borrowSeconds, limit - segment.end));
  return slot + room;
}
