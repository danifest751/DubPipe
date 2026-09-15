import type { DubConfig } from '../config/schema.js';
import type { SpeakerProfiles } from '../core/overrides.js';
import { lengthVerdict, type LengthVerdict } from './s3-translate.js';
import { effectiveGender, genderDisputed } from '../providers/diarization/gender.js';
import type { Segment } from '../core/types.js';

/**
 * Финальная рецензия перевода — разбор ответа и применение правок.
 *
 * Отдельным файлом от самой стадии по одной причине: решение «принять правку или
 * отвергнуть» должно проверяться тестами без модели и без сети. Всё, что здесь
 * лежит, — чистые функции; запрос к модели делает стадия.
 *
 * Зачем проход вообще: перевод идёт пакетами по десять реплик с тремя соседями
 * для контекста, и целый класс ошибок в такой рамке не виден. На реальном
 * материале это имя героини в трёх написаниях («Эва», «Ева», «Эвей»), мужской
 * род у женского персонажа («ты начал» про Еву), непереведённый кусок посреди
 * русской фразы и падеж собственного имени («из Векса» вместо «из Вексы»).
 */

export interface ReviewChange {
  id: number;
  text_ru: string;
  /** Чем плоха прежняя формулировка — для журнала прогона, не для конвейера. */
  reason?: string;
}

export interface RejectedChange extends ReviewChange {
  /** Почему правка не принята. */
  why: 'unknown_id' | 'empty' | 'same' | 'worse_fit';
}

export interface ReviewOutcome {
  segments: Segment[];
  applied: ReviewChange[];
  rejected: RejectedChange[];
  /** Рецензия отброшена целиком: правок оказалось больше, чем позволено. */
  discarded: boolean;
}

/** Разбирает ответ рецензии. Лишние поля и посторонние записи молча отбрасываются. */
export function parseReviewResponse(raw: string, expectedIds: Set<number>): ReviewChange[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('в ответе рецензии нет JSON');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error(`ответ рецензии не разбирается как JSON: ${(error as Error).message}`);
  }

  const container = parsed as Record<string, unknown>;
  const rawChanges = container['changes'];
  if (!Array.isArray(rawChanges)) throw new Error('в ответе рецензии нет массива changes');

  const changes: ReviewChange[] = [];
  const seen = new Set<number>();
  for (const entry of rawChanges) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'number' ? record['id'] : Number(record['id']);
    const text = record['text_ru'] ?? record['ru'] ?? record['text'];
    if (!Number.isInteger(id) || !expectedIds.has(id) || typeof text !== 'string') continue;
    // Одна реплика — одна правка: повтор означает, что модель передумала, и
    // разбираться, какая из версий свежее, не в чем.
    if (seen.has(id)) continue;
    seen.add(id);
    const reason = typeof record['reason'] === 'string' ? record['reason'].trim().slice(0, 120) : '';
    changes.push(reason ? { id, text_ru: text.trim(), reason } : { id, text_ru: text.trim() });
  }
  return changes;
}

/** Меньше этого числа реплик доля переписанного ни о чём не говорит. */
const MIN_LINES_FOR_SHARE = 20;

/**
 * Недолёт считается втрое дешевле перелёта.
 *
 * Промахи не равны по цене. Реплика длиннее слота заставит S6 ускорять её или
 * резать — это слышно на каждом просмотре. Реплика короче оставит паузу, и её
 * не замечает никто. Пока обе стороны весили одинаково, предохранитель отклонял
 * языковые правки за то, что они короче прежнего текста: на третьем эпизоде так
 * отсеялось 15 правок из 16, включая «Юкай не сдавал» → «Юкай не сдал меня».
 * А модель, чтобы пройти проверку, добивала реплики повтором сказанного — и это
 * как раз слышно.
 *
 * Тройка — не замер, а соотношение цены: ускорение на 15% различимо, пауза в
 * полсекунды — нет. Доля укладки в отчёте считается по-прежнему симметрично:
 * она меряет синхронность, а не решает, принять ли правку.
 */
const UNDERSHOOT_PRICE = 1 / 3;

/** Насколько реплика промахивается мимо своего времени; 0 — попадает. */
function missBy(verdict: LengthVerdict): number {
  if (verdict.withinTolerance) return 0;
  const excess = verdict.estimatedSeconds - verdict.slotSeconds;
  return excess > 0 ? excess : -excess * UNDERSHOOT_PRICE;
}

export interface ApplyReviewOptions {
  /** Время, отведённое реплике: слот плюс занимаемая пауза — мерка конвейера. */
  room: (segment: Segment) => number;
  charsPerSecond: number;
  overheadSeconds: number;
  tolerance: number;
  toleranceFloorSeconds: number;
  /** Принимать ли правку, укладывающуюся хуже прежней. */
  allowWorseFit: boolean;
  /** Доля изменённых реплик, выше которой рецензия отбрасывается целиком. */
  maxChangesShare: number;
}

/**
 * Применяет правки рецензии к репликам.
 *
 * Два предохранителя, и оба не про вкус, а про измеримое. Первый: правка не
 * должна укладываться в слот хуже прежней — иначе мы меняем точность перевода на
 * рассинхрон, а укладка потом всё равно её порежет. Второй: если модель
 * переписала больше `maxChangesShare` реплик, она не отредактировала фильм, а
 * перевела его заново — такую рецензию не принимаем вовсе.
 */
export function applyReview(
  segments: Segment[],
  changes: ReviewChange[],
  options: ApplyReviewOptions,
): ReviewOutcome {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const applied: ReviewChange[] = [];
  const rejected: RejectedChange[] = [];

  const verdictFor = (segment: Segment, text: string): LengthVerdict =>
    lengthVerdict(
      text,
      options.room(segment),
      options.charsPerSecond,
      options.tolerance,
      options.toleranceFloorSeconds,
      options.overheadSeconds,
    );

  for (const change of changes) {
    const segment = byId.get(change.id);
    if (!segment) {
      rejected.push({ ...change, why: 'unknown_id' });
      continue;
    }
    const next = change.text_ru.trim();
    if (!next) {
      rejected.push({ ...change, why: 'empty' });
      continue;
    }
    const current = (segment.text_ru ?? '').trim();
    if (next === current) {
      rejected.push({ ...change, why: 'same' });
      continue;
    }
    if (!options.allowWorseFit && current) {
      const before = missBy(verdictFor(segment, current));
      const after = missBy(verdictFor(segment, next));
      // Допуск в 50 мс: колебание в пределах одного знака поводом не считаем.
      if (after > before + 0.05) {
        rejected.push({ ...change, why: 'worse_fit' });
        continue;
      }
    }
    applied.push(change);
  }

  const translated = segments.filter((segment) => (segment.text_ru ?? '').trim()).length;
  const share = translated > 0 ? applied.length / translated : 0;
  /*
   * Доля имеет смысл только на достаточном числе реплик.
   *
   * На коротком куске «переписано 100%» значит «переписаны обе реплики», а не
   * «модель перевела фильм заново». Предохранитель, срабатывающий на трёх
   * строках, отбрасывал бы законные правки — это нашлось тестами сразу.
   */
  if (translated >= MIN_LINES_FOR_SHARE && applied.length > 0 && share > options.maxChangesShare) {
    return { segments, applied: [], rejected: [...rejected], discarded: true };
  }

  const updated = segments.map((segment) => {
    const change = applied.find((entry) => entry.id === segment.id);
    // Разметка фраз относилась к прежнему тексту — вместе с ним она и уходит.
    return change ? { ...segment, text_ru: change.text_ru.trim(), phrases: null } : segment;
  });
  return { segments: updated, applied, rejected, discarded: false };
}

/**
 * Журнал рецензии: что она предложила, что с этим стало и почему.
 *
 * Рецензия — единственная стадия, которая переписывает уже готовый русский
 * текст, и делала она это молча: в `segments.json` оставался только итог.
 * Предохранители стерегут укладку, но не смысл — уложившаяся в слот выдумка
 * проходит насквозь, и заметить её можно, лишь сравнив с тем, что было. Журнал
 * и есть это сравнение: он не решает за человека, но даёт ему на что смотреть.
 */
export interface ReviewJournalEntry {
  id: number;
  /** Русский текст до рецензии. */
  before: string;
  /** Что предложила рецензия. */
  after: string;
  /** Пояснение модели, чем плоха прежняя формулировка. */
  reason?: string;
  /**
   * `applied` — правка в тексте; остальное — почему её не взяли.
   * `dropped` — отклонена в первом заходе и не уложилась при переспросе;
   * `discarded` — рецензия отброшена целиком, вместе с этой правкой.
   */
  verdict: 'applied' | RejectedChange['why'] | 'dropped' | 'discarded';
  /** Промах мимо слота до и после правки, в секундах; 0 — реплика укладывается. */
  miss_before: number;
  miss_after: number;
}

export interface ReviewJournal {
  reviewed_at: string;
  engine: string;
  model: string;
  /** Сколько реплик показали рецензии. */
  lines: number;
  applied: number;
  rejected: number;
  /** Рецензия отброшена целиком: в тексте не изменилось ничего. */
  discarded: boolean;
  entries: ReviewJournalEntry[];
}

/**
 * Собирает журнал по исходным репликам, всем предложениям рецензии и решению
 * `applyReview`.
 *
 * Предложения нужны отдельно от решения: отбрасывая рецензию целиком,
 * `applyReview` возвращает пустой список принятых, и журнал по нему потерял бы
 * ровно то, ради чего его смотрят, — какие 52 правки из 76 вызвали отказ.
 */
export function buildJournal(
  before: Segment[],
  proposed: ReviewChange[],
  outcome: ReviewOutcome,
  options: ApplyReviewOptions,
  about: { engine: string; model: string; lines: number },
): ReviewJournal {
  const byId = new Map(before.map((segment) => [segment.id, segment]));
  const miss = (segment: Segment, text: string): number =>
    missBy(
      lengthVerdict(
        text,
        options.room(segment),
        options.charsPerSecond,
        options.tolerance,
        options.toleranceFloorSeconds,
        options.overheadSeconds,
      ),
    );

  const entry = (change: ReviewChange, verdict: ReviewJournalEntry['verdict']): ReviewJournalEntry | null => {
    const segment = byId.get(change.id);
    if (!segment) {
      // Реплики с таким номером в фильме нет — сравнивать не с чем.
      return { id: change.id, before: '', after: change.text_ru, reason: change.reason, verdict, miss_before: 0, miss_after: 0 };
    }
    const previous = (segment.text_ru ?? '').trim();
    const next = change.text_ru.trim();
    return {
      id: change.id,
      before: previous,
      after: next,
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      verdict,
      miss_before: Number(miss(segment, previous).toFixed(2)),
      miss_after: next ? Number(miss(segment, next).toFixed(2)) : 0,
    };
  };

  const rejectedById = new Map(outcome.rejected.map((change) => [change.id, change.why]));
  const appliedIds = new Set(outcome.applied.map((change) => change.id));
  const verdictOf = (change: ReviewChange): ReviewJournalEntry['verdict'] => {
    if (outcome.discarded) return 'discarded';
    if (appliedIds.has(change.id)) return 'applied';
    const why = rejectedById.get(change.id);
    // Ни в принятых, ни в отклонённых: переспрос пересобирает набор заново, и
    // правка первого захода, не уложившаяся и со второй попытки, до решения не
    // доходит. Звать это «отброшенной рецензией» было бы неправдой.
    return why ?? 'dropped';
  };

  const entries: ReviewJournalEntry[] = [];
  const seen = new Set<number>();
  // Решение впереди предложения: после переспроса по длине принят другой текст,
  // и в журнале должен стоять он, а не первая формулировка.
  for (const change of [...outcome.applied, ...outcome.rejected, ...proposed]) {
    if (seen.has(change.id)) continue;
    seen.add(change.id);
    const row = entry(change, verdictOf(change));
    if (row) entries.push(row);
  }
  entries.sort((a, b) => a.id - b.id);

  return {
    reviewed_at: new Date().toISOString(),
    engine: about.engine,
    model: about.model,
    lines: about.lines,
    applied: outcome.discarded ? 0 : outcome.applied.length,
    rejected: outcome.rejected.length,
    discarded: outcome.discarded,
    entries,
  };
}

/** Описания проверок для промпта: в список попадают только включённые. */
const CHECK_TEXT: Record<keyof DubConfig['translate']['review']['checks'], string> = {
  gender:
    '- **Род.** Глаголы и прилагательные должны согласовываться с полом говорящего, ' +
    'указанным в `gender`. Он замерен по голосу в записи, а где замер промолчал — выведен ' +
    'из рода в самом переводе. Правь **окончание**, а не выбрасывай слово: «я сказал» у ' +
    'женщины становится «я сказала», а не исчезает из реплики — иначе вместе с ошибкой ' +
    'уходит смысл, и правка ещё и не влезает в своё время. ' +
    'Следи и за родом того, о ком говорят, если это понятно из соседних реплик.',
  glossary:
    '- **Имена и термины.** Одно имя — одно написание на весь фильм, в правильных падежах. ' +
    'Латиница в русской реплике недопустима: если имя осталось непереведённым, переведи.',
  address:
    '- **Ты и вы.** У одной пары героев обращение одинаково на весь фильм. ' +
    'Если оно меняется намеренно (ссора, переход на официальный тон) — оставь.',
  consistency:
    '- **Единообразие.** Один и тот же предмет, звание или устройство называются одинаково. ' +
    'Манера речи персонажа не должна прыгать между сценами.',
  meaning:
    '- **Смысл.** Сверяй с оригиналом: перевёрнутые отрицания, потерянные вопросы, ' +
    'куски, оставшиеся на языке оригинала, и фразы, означающие не то, что сказано в `en`.',
  grammar:
    '- **Правила языка.** Падежи, согласование, управление глаголов, предлоги, числительные, ' +
    'отрицания. Ошибка в падеже собственного имени («из Векса» вместо «из Вексы») или в ' +
    'управлении («уверен о том») слышна сразу, даже когда смысл понятен. Проверяй и пунктуацию ' +
    'там, где от неё меняется чтение вслух.',
  phrasing:
    '- **Строй фразы.** Реплику произнесут вслух, а не прочитают. Порядок слов — русский, а не ' +
    'перенесённый из оригинала; дословные обороты и канцелярит («я вижу, что ты начал») заменяй ' +
    'тем, как сказал бы живой человек в этой сцене. Смысл при этом не меняется, и регистр речи ' +
    'героя остаётся прежним: грубый не становится вежливым.',
  length:
    '- **Длина.** У реплик с ненулевым `over` перевод не помещается в отведённое время. ' +
    'Сократи их, не теряя смысла. Соседнюю реплику того же говорящего можно укоротить, ' +
    'чтобы освободить место, — но переносить текст между репликами нельзя.',
};

/** Список включённых проверок — подставляется в промпт вместо `{checks}`. */
export function checksSection(checks: DubConfig['translate']['review']['checks']): string {
  const lines = (Object.keys(CHECK_TEXT) as Array<keyof typeof CHECK_TEXT>)
    .filter((name) => checks[name])
    .map((name) => CHECK_TEXT[name]);
  return lines.length > 0 ? lines.join('\n') : '- Ничего: все проверки отключены, верни пустой список правок.';
}

/**
 * Сколько знаков просить у реплики: цель и границы допуска.
 *
 * Одного потолка мало, и это стоило целого захода переспроса: рецензент,
 * получив «не длиннее 104 знаков», честно вернул 69 — и правка была отвергнута,
 * потому что мерка конвейера требует не «не длиннее», а попадания в слот.
 * Недолёт — такой же промах, как перелёт: реплика отзвучит раньше и оставит
 * паузу. Поэтому даём цель и обе границы, как это делает проход подгонки длины.
 */
export interface CharBudget {
  target_chars: number;
  min_chars: number;
  max_chars: number;
}

export function charBudget(seconds: number, options: ApplyReviewOptions): CharBudget {
  const allowedSeconds = Math.max(seconds * options.tolerance, options.toleranceFloorSeconds);
  const chars = (value: number) =>
    Math.max(1, Math.round(Math.max(0, value - options.overheadSeconds) * options.charsPerSecond));
  return {
    target_chars: chars(seconds),
    min_chars: chars(seconds - allowedSeconds),
    max_chars: chars(seconds + allowedSeconds),
  };
}

/** На сколько знаков текст выходит за допуск: плюс — длинный, минус — короткий, 0 — в цель. */
export function charsOutside(text: string, budget: CharBudget): number {
  if (text.length > budget.max_chars) return text.length - budget.max_chars;
  if (text.length < budget.min_chars) return text.length - budget.min_chars;
  return 0;
}

/** Одна реплика в том виде, в каком её видит рецензент. */
/**
 * Что рецензия знает о длине реплики — только предел, и только сверху.
 *
 * Раньше сюда шли `target_chars`, `min_chars` и знаковый `off`, и рецензия,
 * видя «короче цели на 41 знак», добивала реплику повтором сказанного: «Ты убил
 * троих наших. Троих наших людей.» На третьем эпизоде так вышло больше половины
 * её правок. Запрещать это словами в промпте не помогло — она слушается данных.
 * Поэтому про недолёт ей просто не говорят: пауза дешевле ускорения, а короткая
 * живая реплика лучше набитой. Длину снизу добирает подгонка S6.
 */
export interface ReviewLine {
  id: number;
  speaker: string;
  gender: string;
  /** Тон и текст о поле этого говорящего спорят — род лучше не трогать. */
  gender_disputed?: boolean;
  name?: string;
  en: string;
  ru: string;
  /** Сколько знаков не влезает в отведённое время; 0 — реплика помещается. */
  over: number;
  max_chars: number;
}

/** Собирает реплики для рецензии: оригинал, перевод, кто говорит и сколько места. */
export function buildReviewLines(
  segments: Segment[],
  options: ApplyReviewOptions & { speakers: SpeakerProfiles; names: Record<string, string> },
): ReviewLine[] {
  return segments
    .filter((segment) => (segment.text_ru ?? '').trim())
    .map((segment) => {
      const text = segment.text_ru!.trim();
      const budget = charBudget(options.room(segment), options);
      const name = options.names[segment.speaker];
      return {
        id: segment.id,
        speaker: segment.speaker,
        // Пол — объединённый вердикт: тон, а где он промолчал — род в тексте.
        // Спор двух улик рецензии сообщается прямо: правя род по ошибочному
        // замеру, она портила верный текст, а так у неё есть повод не трогать.
        gender: effectiveGender(options.speakers[segment.speaker]),
        ...(genderDisputed(options.speakers[segment.speaker]) ? { gender_disputed: true } : {}),
        ...(name ? { name } : {}),
        en: segment.text_en ?? '',
        ru: text,
        max_chars: budget.max_chars,
        over: Math.max(0, text.length - budget.max_chars),
      };
    });
}

/** Отклонённая за длину правка в том виде, в каком её показывают модели на переспросе. */
export interface RefitLine {
  id: number;
  en: string;
  ru: string;
  proposed: string;
  reason: string;
  /** На сколько знаков правка длиннее допустимого. */
  over: number;
  max_chars: number;
  /**
   * На сколько знаков правка короче прежнего текста.
   *
   * Правку отклоняют не только за длину: чаще она короче того, что исправляла,
   * потому что модель выбросила слово вместо того, чтобы поправить окончание —
   * «я сказал» у женщины превращалось в пустоту вместо «я сказала». Без этого
   * числа переспрос не мог помочь: он видел правку, которая и так влезает.
   */
  shorter_by?: number;
}

/**
 * Собирает переспрос по правкам, отклонённым за длину.
 *
 * Молча выбрасывать их расточительно: рецензия нашла настоящую ошибку и лишь
 * сформулировала длиннее, чем помещается, — на реальном эпизоде так отсеивалось
 * 27 правок из 46. Модели показывают её же правку, её же причину и точную
 * нехватку знаков.
 */
export function buildRefitLines(
  segments: Segment[],
  rejected: RejectedChange[],
  options: ApplyReviewOptions,
): RefitLine[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const lines: RefitLine[] = [];
  for (const change of rejected) {
    if (change.why !== 'worse_fit') continue;
    const segment = byId.get(change.id);
    if (!segment) continue;
    const budget = charBudget(options.room(segment), options);
    const proposed = change.text_ru.trim();
    const current = (segment.text_ru ?? '').trim();
    lines.push({
      id: change.id,
      en: segment.text_en ?? '',
      ru: current,
      proposed,
      reason: change.reason ?? '',
      max_chars: budget.max_chars,
      over: Math.max(0, proposed.length - budget.max_chars),
      ...(current.length - proposed.length > 0 ? { shorter_by: current.length - proposed.length } : {}),
    });
  }
  return lines;
}

/**
 * Режет реплики на заходы с нахлёстом.
 *
 * Смысл прохода — в широком контексте, поэтому дробить стоит только то, что
 * действительно не влезает. Нахлёст нужен, чтобы на стыке рецензент видел, чем
 * кончилась предыдущая сцена.
 */
export function reviewChunks<T>(lines: T[], batchSize: number, overlap: number): T[][] {
  if (lines.length <= batchSize) return lines.length > 0 ? [lines] : [];
  const step = Math.max(1, batchSize - overlap);
  const chunks: T[][] = [];
  for (let start = 0; start < lines.length; start += step) {
    chunks.push(lines.slice(start, start + batchSize));
    if (start + batchSize >= lines.length) break;
  }
  return chunks;
}
