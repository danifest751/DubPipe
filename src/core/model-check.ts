import type { DubConfig } from '../config/schema.js';
import { estimateCost, loadCatalog, type CatalogModel } from '../providers/llm/catalog.js';
import { lengthVerdict, roomFor, translateSegments, type RunUsage } from '../stages/s3-translate.js';
import { clientFor, comparisonConfig } from './compare.js';
import { makeSegment } from './types.js';

/**
 * Проверка модели перевода из настроек (ТЗ §16.4): три короткие реплики
 * переводятся выбранной моделью, и по ответу видно, годится ли она —
 * отвечает ли вообще, по-русски ли, укладывается ли в слоты, сколько
 * это стоит и как долго идёт. Каталог шлюза таких гарантий не даёт:
 * в нём есть модели без инструкций, с фильтрами и просто мёртвые.
 */

// Слоты — как в обычной речи: хорошая модель укладывается без сокращений,
// а многословная сразу видна по оранжевым строкам. Конкретный запас считается
// по настройкам темпа, а не зашит здесь числом.
export const CHECK_SAMPLE: ReadonlyArray<{ start: number; end: number; text_en: string }> = [
  { start: 0, end: 3.2, text_en: 'So what do you think about the new plan?' },
  { start: 3.6, end: 6.6, text_en: 'Honestly, it looks better than the last one.' },
  { start: 7.0, end: 8.4, text_en: 'Fine. Get us out of here.' },
];

/**
 * Причина отказа — одной строкой: шлюз отвечает JSON с длинным сообщением,
 * а стадия добавляет свои префиксы; человеку нужна суть.
 */
export function tidyReason(message: string): string {
  let text = message.replace(/^\[s\d\]\s*/, '').replace(/^пакет \d+\/\d+:\s*/, '');
  const gateway = /Шлюз ответил (\d+):\s*(\{[\s\S]*)$/.exec(text);
  if (gateway) {
    let detail = gateway[2]!;
    try {
      const parsed = JSON.parse(detail) as { error?: unknown; message?: unknown };
      const inner = parsed.error;
      detail =
        typeof inner === 'string'
          ? inner
          : inner && typeof inner === 'object' && typeof (inner as { message?: unknown }).message === 'string'
            ? (inner as { message: string }).message
            : typeof parsed.message === 'string'
              ? parsed.message
              : detail;
    } catch {
      // Обрезанный JSON — берём первое поле руками.
      const match = /"(?:error|message)"\s*:\s*"([^"]+)"/.exec(detail);
      if (match) detail = match[1]!;
    }
    text = `шлюз ответил ${gateway[1]}: ${detail}`;
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export interface ModelCheckLine {
  text_en: string;
  text_ru: string | null;
  fits: boolean;
}

export interface ModelCheck {
  ok: boolean;
  model: string;
  reason: string | null;
  elapsedMs: number;
  usage: RunUsage | null;
  costUsd: number | null;
  lines: ModelCheckLine[];
}

const CYRILLIC = /[а-яё]/i;

/** Вердикт по строкам: все переведены, по-русски и не повторяют оригинал. */
export function judgeTranslation(lines: ModelCheckLine[]): { ok: boolean; reason: string | null } {
  if (lines.length === 0) return { ok: false, reason: 'модель не вернула ни одной реплики' };
  const missing = lines.filter((line) => !line.text_ru || !line.text_ru.trim()).length;
  if (missing > 0) return { ok: false, reason: `переведено ${lines.length - missing} из ${lines.length} реплик` };
  const foreign = lines.filter((line) => !CYRILLIC.test(line.text_ru!)).length;
  if (foreign > 0) return { ok: false, reason: `ответ не по-русски в ${foreign} из ${lines.length} реплик` };
  return { ok: true, reason: null };
}

export async function checkModel(config: DubConfig, modelId: string, timeoutMs = 60_000): Promise<ModelCheck> {
  const started = Date.now();
  const runConfig: DubConfig = {
    ...comparisonConfig(config, timeoutMs),
    // Одна короткая просьба: без корректирующего прохода и с одним пакетом.
    translate: { ...config.translate, fit_length_pass: false, batch_size: 10 },
  };
  const segments = CHECK_SAMPLE.map((item, index) => makeSegment({ id: index, ...item }));
  const empty = (): ModelCheck => ({
    ok: false,
    model: modelId,
    reason: null,
    elapsedMs: Date.now() - started,
    usage: null,
    costUsd: null,
    lines: [],
  });

  let catalog: CatalogModel[] = [];
  try {
    catalog = await loadCatalog(config);
  } catch {
    // Без каталога стоимость возьмём из ответа шлюза.
  }

  try {
    const client = await clientFor(runConfig, modelId);
    const run = await Promise.race([
      translateSegments(client, runConfig, segments),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`нет ответа за ${Math.round(timeoutMs / 1000)} с`)), timeoutMs)),
    ]);
    const cps = runConfig.translate.chars_per_second;
    const tolerance = runConfig.translate.length_tolerance;
    const floor = runConfig.translate.length_tolerance_floor_ms / 1000;
    const overhead = runConfig.translate.speech_overhead_seconds;
    // Судить перевод надо тем же, чем стадия его заказывала: место реплики
    // вместе с занимаемой паузой и надбавка на каждую реплику. По голому слоту
    // проверка занижала любую модель — в том числе заведомо годную.
    const room = roomFor(runConfig, run.segments);
    const lines: ModelCheckLine[] = run.segments.map((segment) => ({
      text_en: segment.text_en,
      text_ru: segment.text_ru,
      fits: segment.text_ru
        ? lengthVerdict(segment.text_ru, room(segment), cps, tolerance, floor, overhead).withinTolerance
        : false,
    }));
    const verdict = judgeTranslation(lines);
    const entry = catalog.find((item) => item.id === modelId);
    return {
      ok: verdict.ok,
      model: modelId,
      reason: verdict.reason,
      elapsedMs: Date.now() - started,
      usage: run.usage,
      costUsd: entry ? estimateCost(entry, run.usage) : run.usage.cost,
      lines,
    };
  } catch (error) {
    return { ...empty(), reason: tidyReason((error as Error).message) };
  }
}
