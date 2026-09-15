import type { DubConfig } from '../config/schema.js';
import type { SpeakerProfiles } from '../core/overrides.js';
import { lengthVerdict, type LengthVerdict } from './s3-translate.js';
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

/** Насколько реплика промахивается мимо своего времени; 0 — попадает. */
function missBy(verdict: LengthVerdict): number {
  return verdict.withinTolerance ? 0 : Math.abs(verdict.estimatedSeconds - verdict.slotSeconds);
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
    return change ? { ...segment, text_ru: change.text_ru.trim() } : segment;
  });
  return { segments: updated, applied, rejected, discarded: false };
}

/** Описания проверок для промпта: в список попадают только включённые. */
const CHECK_TEXT: Record<keyof DubConfig['translate']['review']['checks'], string> = {
  gender:
    '- **Род.** Глаголы и прилагательные должны согласовываться с полом говорящего, ' +
    'указанным в `gender`. Он замерен по голосу в записи и надёжнее догадки по тексту. ' +
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

/** Одна реплика в том виде, в каком её видит рецензент. */
export interface ReviewLine {
  id: number;
  speaker: string;
  gender: string;
  name?: string;
  en: string;
  ru: string;
  max_chars: number;
  over: number;
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
      const seconds = options.room(segment);
      const maxChars = Math.max(
        1,
        Math.round(Math.max(0, seconds - options.overheadSeconds) * options.charsPerSecond),
      );
      const name = options.names[segment.speaker];
      return {
        id: segment.id,
        speaker: segment.speaker,
        gender: options.speakers[segment.speaker]?.gender ?? '—',
        ...(name ? { name } : {}),
        en: segment.text_en ?? '',
        ru: text,
        max_chars: maxChars,
        over: Math.max(0, text.length - maxChars),
      };
    });
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
