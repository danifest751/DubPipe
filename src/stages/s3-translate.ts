import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { packageRoot } from '../config/load.js';
import type { DubConfig } from '../config/schema.js';
import { cancellation } from '../core/cancel.js';
import { StageError } from '../core/errors.js';
import { languageProfile } from '../core/languages.js';
import { counter, log } from '../core/logger.js';
import { availableSeconds, slotOf, type Segment } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import { selectChatClient, type ChatClient, type ChatUsage } from '../providers/llm/index.js';
import { formatCost } from '../providers/llm/catalog.js';
import { effectiveSpeechShape } from '../core/calibration.js';

/**
 * S3 — batched EN→RU translation with length control (SPEC FR-3, §3.4).
 *
 * Length is measured as estimated spoken duration against the replica's slot,
 * not as word count versus the original: word count says nothing about whether
 * the line fits the timing, which is the only thing that matters for dubbing.
 */

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested without network access
// ---------------------------------------------------------------------------

/** Rough spoken length of a Russian line at the configured speech rate. */
export function estimateSpeechSeconds(text: string, charsPerSecond: number, overheadSeconds = 0): number {
  const normalized = text.trim().replace(/\s+/g, ' ');
  // Та же модель, что и при расчёте цели: надбавка плюс знаки, делённые на
  // темп. Считать по-разному здесь и там — верный способ получить отчёт, где
  // нормальные реплики объявлены недобором.
  return overheadSeconds + normalized.length / charsPerSecond;
}

export interface LengthVerdict {
  estimatedSeconds: number;
  slotSeconds: number;
  /** Estimated duration divided by the slot: 1.0 is a perfect fit. */
  ratio: number;
  withinTolerance: boolean;
}

/**
 * Length check against the slot.
 *
 * `toleranceFloorSeconds` is an absolute floor on the allowed deviation: on a
 * 0.7 s slot ±15% is ±1.5 characters, a target no language can hit, so short
 * replicas would fail the criterion no matter how good the translation is.
 */
export function lengthVerdict(
  textRu: string,
  slotSeconds: number,
  charsPerSecond: number,
  tolerance: number,
  toleranceFloorSeconds = 0,
  overheadSeconds = 0,
): LengthVerdict {
  const estimatedSeconds = estimateSpeechSeconds(textRu, charsPerSecond, overheadSeconds);
  const ratio = slotSeconds > 0 ? estimatedSeconds / slotSeconds : Infinity;
  const allowed = Math.max(slotSeconds * tolerance, toleranceFloorSeconds);
  return {
    estimatedSeconds,
    slotSeconds,
    ratio,
    withinTolerance: Math.abs(estimatedSeconds - slotSeconds) <= allowed,
  };
}

/** Character budget that fits the slot at the configured rate. */
export function targetChars(
  slotSeconds: number,
  charsPerSecond: number,
  tolerance = 0,
  overheadSeconds = 0,
): number {
  /*
   * У каждой реплики есть постоянная надбавка — подход к фразе и хвост после
   * неё, которые синтезатор добавляет всегда. Замер на 255 репликах: реплики
   * короче 15 знаков идут со скоростью 10.2 знака в секунду, длиннее 80 — со
   * скоростью 16.6, хотя голос один и тот же. Разницу создаёт именно надбавка:
   * на короткой реплике она съедает половину времени.
   *
   * Одним числом это описать нельзя: целясь в средний темп, мы всегда просим у
   * длинных реплик меньше, чем влезет, а у коротких больше. Поэтому из слота
   * сначала вычитается надбавка, а темп берётся настоящий — 17.8 знака в
   * секунду вместо кажущихся 12.5.
   */
  const speaking = Math.max(0, slotSeconds - overheadSeconds);
  return Math.max(1, Math.round(speaking * charsPerSecond * (1 + tolerance)));
}

/**
 * Русский текст в среднем длиннее английского на 15–25% по символам; вдвое —
 * это уже не перевод, а сочинение. Ограничение нужно, потому что слот бывает
 * ошибочно огромным (слово, растянутое ASR через паузу), и модель, получив цель
 * «1100 символов» для одного слова, послушно выдумывала монолог.
 */
export const MAX_EXPANSION = 2.0;

/** Цель по длине, ограниченная сверху тем, что вообще есть в оригинале. */
export function boundedTargetChars(
  source: string,
  slotSeconds: number,
  charsPerSecond: number,
  expansionCap: number = MAX_EXPANSION,
  overheadSeconds = 0,
): number {
  const bySlot = targetChars(slotSeconds, charsPerSecond, 0, overheadSeconds);
  const bySource = Math.max(8, Math.round(source.trim().length * expansionCap));
  return Math.min(bySlot, bySource);
}

/**
 * Groups replicas into request batches (SPEC §3.4: 8–12 replicas of one scene).
 * A pause longer than `sceneGapSeconds` is treated as a scene change, so context
 * never leaks across an obvious cut.
 */
export function planBatches(segments: Segment[], batchSize: number, sceneGapSeconds = 3): Segment[][] {
  const batches: Segment[][] = [];
  let current: Segment[] = [];

  for (const [index, segment] of segments.entries()) {
    const previous = segments[index - 1];
    const sceneBreak = previous !== undefined && segment.start - previous.end > sceneGapSeconds;

    if (current.length > 0 && (sceneBreak || current.length >= batchSize)) {
      batches.push(current);
      current = [];
    }
    current.push(segment);
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

export interface TranslationPayload {
  items: Map<number, string>;
  glossary: Record<string, string>;
}

/** Pulls the first balanced JSON object or array out of a model reply. */
export function extractJson(raw: string): string | null {
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const opening = text[start]!;
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === opening) depth++;
    else if (char === closing) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Validates a batch reply. Matching is by `id`, never by position, because
 * models drop and merge array elements (SPEC §3.4, revised).
 */
export function parseTranslationResponse(raw: string, expectedIds: number[]): TranslationPayload {
  const json = extractJson(raw);
  if (!json) throw new Error('в ответе модели нет JSON');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`ответ не разбирается как JSON: ${(error as Error).message}`);
  }

  const container = Array.isArray(parsed) ? { items: parsed } : (parsed as Record<string, unknown>);
  const rawItems = container['items'];
  if (!Array.isArray(rawItems)) throw new Error('в ответе нет массива items');

  const expected = new Set(expectedIds);
  const items = new Map<number, string>();

  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'number' ? record['id'] : Number(record['id']);
    const text = record['text_ru'] ?? record['ru'] ?? record['text'];
    if (!Number.isInteger(id) || !expected.has(id) || typeof text !== 'string') continue;
    if (text.trim()) items.set(id, text.trim());
  }

  const glossary: Record<string, string> = {};
  const rawGlossary = container['glossary'];
  if (rawGlossary && typeof rawGlossary === 'object' && !Array.isArray(rawGlossary)) {
    for (const [key, value] of Object.entries(rawGlossary as Record<string, unknown>)) {
      if (typeof value === 'string' && key.trim() && value.trim()) glossary[key.trim()] = value.trim();
    }
  }

  return { items, glossary };
}

export function profanityRule(mode: DubConfig['translate']['profanity']): string {
  switch (mode) {
    case 'keep':
      return 'Переводи ненормативную лексику как есть, не смягчая.';
    case 'hard':
      return 'Ненормативную лексику заменяй символами «***», сохраняя длину реплики.';
    case 'soft':
      return 'Ненормативную лексику смягчай: подбирай разговорный, но приличный эквивалент.';
  }
}

export function renderSystemPrompt(
  template: string,
  values: { glossary: string; context: string; profanityRule: string; sourceLanguage?: string },
): string {
  return template
    .replace('{source_language}', values.sourceLanguage || 'английского')
    .replace('{glossary}', values.glossary || '(пока пуст)')
    .replace('{context}', values.context || '(начало ролика)')
    .replace('{profanity_rule}', values.profanityRule);
}

export function formatGlossary(glossary: Record<string, string>): string {
  const entries = Object.entries(glossary);
  if (entries.length === 0) return '';
  return entries.map(([en, ru]) => `- ${en} → ${ru}`).join('\n');
}

/** The replicas immediately before a batch, shown to keep the dialogue coherent. */
export function formatContext(previous: Segment[]): string {
  if (previous.length === 0) return '';
  return previous
    .map((segment) => `- ${segment.text_en} → ${segment.text_ru ?? '(не переведено)'}`)
    .join('\n');
}

export function buildBatchRequest(
  batch: Segment[],
  charsPerSecond: number,
  expansionCap: number = MAX_EXPANSION,
  overheadSeconds = 0,
  room: (segment: Segment) => number = slotOf,
): string {
  const lines = batch.map((segment) => {
    const slot = room(segment);
    return JSON.stringify({
      id: segment.id,
      slot_seconds: Number(slot.toFixed(2)),
      target_chars: boundedTargetChars(segment.text_en, slot, charsPerSecond, expansionCap, overheadSeconds),
      text_en: segment.text_en,
    });
  });
  return `Переведи реплики. По одной на строку:\n${lines.join('\n')}`;
}

export interface LengthStats {
  total: number;
  withinTolerance: number;
  share: number;
  tooLong: number;
  tooShort: number;
  /** SPEC M2 requires at least 90 % of replicas inside the tolerance. */
  passed: boolean;
}

export function lengthStats(
  segments: Segment[],
  charsPerSecond: number,
  tolerance: number,
  toleranceFloorSeconds = 0,
  overheadSeconds = 0,
  room: (segment: Segment) => number = slotOf,
): LengthStats {
  const translated = segments.filter((segment) => segment.text_ru !== null);
  let within = 0;
  let tooLong = 0;
  let tooShort = 0;

  for (const segment of translated) {
    const verdict = lengthVerdict(
      segment.text_ru!,
      room(segment),
      charsPerSecond,
      tolerance,
      toleranceFloorSeconds,
      overheadSeconds,
    );
    if (verdict.withinTolerance) within++;
    else if (verdict.ratio > 1) tooLong++;
    else tooShort++;
  }

  const share = translated.length ? within / translated.length : 0;
  return {
    total: translated.length,
    withinTolerance: within,
    share,
    tooLong,
    tooShort,
    passed: share >= 0.9,
  };
}


// ---------------------------------------------------------------------------
// Translation core — provider-agnostic, no workspace writes, reusable by
// `dub compare` to run the same replicas through several models.
// ---------------------------------------------------------------------------

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  requests: number;
}

export interface TranslationRun {
  segments: Segment[];
  stats: LengthStats;
  glossary: Record<string, string>;
  usage: RunUsage;
  elapsedMs: number;
  warnings: string[];
}

export interface TranslateOptions {
  /** Called after each batch, e.g. to persist partial progress. */
  onBatch?: (done: number, total: number, segments: Segment[]) => Promise<void> | void;
}

async function loadPromptTemplate(name: string): Promise<string> {
  const target = path.join(packageRoot(), 'prompts', name);
  try {
    return await readFile(target, 'utf8');
  } catch (cause) {
    throw new StageError('s3', `Не найден файл промпта ${name}`, { artifact: target, cause });
  }
}

function addUsage(total: RunUsage, usage: ChatUsage | undefined): void {
  total.requests++;
  if (!usage) return;
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  total.cost += usage.cost ?? 0;
}

/** One batch with up to two retries, then per-replica fallback (SPEC §3.4). */
async function translateBatch(
  client: ChatClient,
  systemPrompt: string,
  batch: Segment[],
  charsPerSecond: number,
  usage: RunUsage,
  expansionCap: number,
  overheadSeconds: number,
  room: (segment: Segment) => number,
): Promise<TranslationPayload> {
  const ids = batch.map((segment) => segment.id);
  const request = buildBatchRequest(batch, charsPerSecond, expansionCap, overheadSeconds, room);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const reply = await client.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: request },
        ],
        { json: true, temperature: attempt === 1 ? 0.3 : 0.1 },
      );
      addUsage(usage, reply.usage);

      const payload = parseTranslationResponse(reply.text, ids);
      if (payload.items.size === ids.length) return payload;

      const missing = ids.filter((id) => !payload.items.has(id));
      log.debug(`пакет: не хватает реплик ${missing.join(', ')} (попытка ${attempt})`);
      if (attempt === 3) return payload;
      lastError = new Error(`модель вернула ${payload.items.size} из ${ids.length} реплик`);
    } catch (error) {
      lastError = error as Error;
      log.debug(`пакет: ответ отклонён (${lastError.message}), попытка ${attempt}`);
      if (attempt === 3) break;
    }
  }

  throw lastError ?? new Error('перевод пакета не удался');
}

/** Replicas that missed the length target, with the direction of the miss. */
export function collectMisfits(
  segments: Segment[],
  charsPerSecond: number,
  tolerance: number,
  toleranceFloorSeconds: number,
  expansionCap: number = MAX_EXPANSION,
  overheadSeconds = 0,
  room: (segment: Segment) => number = slotOf,
): Array<{ segment: Segment; action: 'shorten' | 'expand'; targetChars: number }> {
  const misfits: Array<{ segment: Segment; action: 'shorten' | 'expand'; targetChars: number }> = [];
  for (const segment of segments) {
    if (segment.text_ru === null) continue;
    const slot = room(segment);
    const verdict = lengthVerdict(segment.text_ru, slot, charsPerSecond, tolerance, toleranceFloorSeconds, overheadSeconds);
    if (verdict.withinTolerance) continue;
    const action = verdict.ratio > 1 ? 'shorten' : 'expand';
    const target = boundedTargetChars(segment.text_en, slot, charsPerSecond, expansionCap, overheadSeconds);
    // Удлинять есть смысл, только пока оригинал это оправдывает: если перевод
    // уже исчерпал исходный текст, недобор до слота закроет тишина на S6.
    if (action === 'expand' && segment.text_ru.trim().length >= target) continue;
    misfits.push({ segment, action, targetChars: target });
  }
  return misfits;
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/**
 * Сколько места отведено каждой реплике: её слот плюс пауза, которую займёт
 * укладка. Считается один раз на прогон и раздаётся всем, кому нужно знать
 * длину: заказу перевода, сводке и корректирующему проходу. Разные ответы на
 * этот вопрос в разных местах — источник половины сегодняшних дефектов.
 */
export function roomFor(config: DubConfig, segments: Segment[]): (segment: Segment) => number {
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const byId = new Map(
    ordered.map((segment, index) => [
      segment.id,
      availableSeconds(ordered, index, {
        borrowSeconds: config.alignment.borrow_silence_ms / 1000,
        gapSeconds: config.alignment.gap_ms / 1000,
      }),
    ]),
  );
  return (segment: Segment) => byId.get(segment.id) ?? slotOf(segment);
}

/**
 * Single corrective pass over replicas outside the length window (SPEC FR-3).
 * A rewrite is kept only when it actually improves the fit, so the pass can
 * never make the result worse.
 */
async function fitLengths(
  client: ChatClient,
  config: DubConfig,
  segments: Segment[],
  usage: RunUsage,
): Promise<number> {
  const { chars_per_second: cps, length_tolerance: tolerance, speech_overhead_seconds: overhead } = config.translate;
  const floor = config.translate.length_tolerance_floor_ms / 1000;
  const room = roomFor(config, segments);
  const misfits = collectMisfits(segments, cps, tolerance, floor, languageProfile(config.asr.language).expansionCap, overhead, room);
  if (misfits.length === 0) return 0;
  log.progress(`подгонка длины: реплик вне допуска ${misfits.length}`, null);

  const template = await loadPromptTemplate('fit-length.md');
  const systemPrompt = template.replace('{profanity_rule}', profanityRule(config.translate.profanity));
  let improved = 0;

  for (const batch of chunk(misfits, config.translate.batch_size)) {
    const request = batch
      .map((item) =>
        JSON.stringify({
          id: item.segment.id,
          action: item.action,
          target_chars: item.targetChars,
          text_en: item.segment.text_en,
          text_ru: item.segment.text_ru,
        }),
      )
      .join('\n');

    try {
      const reply = await client.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Перепиши реплики под целевую длину:\n${request}` },
        ],
        { json: true, temperature: 0.2 },
      );
      addUsage(usage, reply.usage);
      const payload = parseTranslationResponse(
        reply.text,
        batch.map((item) => item.segment.id),
      );

      for (const item of batch) {
        const rewritten = payload.items.get(item.segment.id);
        if (!rewritten) continue;
        // Принимать правку надо той же меркой, какой её заказывали: и место,
        // и надбавка на реплику. По голому слоту без надбавки переписанный
        // текст, попавший ровно в заказанную длину, мог быть отвергнут.
        const slot = room(item.segment);
        const before = Math.abs(estimateSpeechSeconds(item.segment.text_ru!, cps, overhead) - slot);
        const after = Math.abs(estimateSpeechSeconds(rewritten, cps, overhead) - slot);
        if (after < before) {
          item.segment.text_ru = rewritten;
          improved++;
        }
      }
    } catch (error) {
      // Cosmetic pass: a failure leaves the original translation in place.
      log.debug(`проход подгонки длины не удался: ${(error as Error).message}`);
    }
  }

  return improved;
}

/**
 * Реплика осталась без перевода. По ТЗ §3.4 на её место ставится оригинал,
 * чтобы конвейер шёл дальше, но это имеет смысл, только если оригинал вообще
 * можно прочитать русским голосом: хангыль или иероглифы синтезатор превратит
 * в мусор, поэтому там честнее тишина — в этом месте останется слышен
 * приглушённый оригинал.
 */
export function markUntranslated(segment: Segment, warnings: string[]): void {
  const readable = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{P}\p{N}\s]+$/u.test(segment.text_en);
  segment.text_ru = readable ? segment.text_en : null;
  if (!segment.flags.includes('translation_failed')) segment.flags.push('translation_failed');
  warnings.push(
    readable
      ? `Реплика ${segment.id} не переведена — оставлен оригинал`
      : `Реплика ${segment.id} не переведена — останется без озвучки`,
  );
}

/**
 * Translates replicas with the given client. Works on copies and writes nothing,
 * so the same input can be run through several models side by side.
 */
export async function translateSegments(
  client: ChatClient,
  config: DubConfig,
  input: Segment[],
  options: TranslateOptions = {},
): Promise<TranslationRun> {
  const started = Date.now();
  const warnings: string[] = [];
  const usage: RunUsage = { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 };
  const segments = input.map((segment) => ({ ...segment, flags: [...segment.flags] }));

  const {
    chars_per_second: cps,
    length_tolerance: tolerance,
    context_segments: contextSize,
    speech_overhead_seconds: overhead,
  } = config.translate;
  const room = roomFor(config, segments);
  const floor = config.translate.length_tolerance_floor_ms / 1000;

  if (segments.length === 0) {
    return {
      segments,
      stats: lengthStats([], cps, tolerance, floor, overhead, room),
      glossary: {},
      usage,
      elapsedMs: 0,
      warnings: ['Нет реплик для перевода'],
    };
  }

  const template = await loadPromptTemplate('translate.md');
  let failedBatches = 0;
  // Язык оригинала — параметр: от него зависят и предел длины перевода, и промпт.
  const sourceLanguage = languageProfile(config.asr.language);
  const batches = planBatches(segments, config.translate.batch_size);
  const glossary: Record<string, string> = {};

  for (const [index, batch] of batches.entries()) {
    cancellation.throwIfCancelled();
    const firstId = batch[0]!.id;
    const contextSegments = segments
      .filter((segment) => segment.id < firstId && segment.text_ru !== null)
      .slice(-contextSize);

    const systemPrompt = renderSystemPrompt(template, {
      glossary: formatGlossary(glossary),
      context: formatContext(contextSegments),
      profanityRule: profanityRule(config.translate.profanity),
      sourceLanguage: sourceLanguage.name,
    });

    let payload: TranslationPayload;
    try {
      payload = await translateBatch(client, systemPrompt, batch, cps, usage, sourceLanguage.expansionCap, overhead, room);
    } catch (error) {
      // Один упрямый пакет не должен обнулять час работы: на 99 пакетах модель
      // почти наверняка где-нибудь нарушит формат ответа или не уложится в
      // таймаут. Реплики пакета остаются непереведёнными и помечаются флагом,
      // прогон идёт дальше, а сводка в конце говорит, сколько потеряно.
      failedBatches++;
      const reason = (error as Error).message;
      log.warn(`Пакет ${index + 1}/${batches.length} не переведён (${reason})`);
      warnings.push(
        `Пакет ${index + 1}/${batches.length} не переведён (${reason}): ` +
          `реплики ${batch[0]!.id}–${batch[batch.length - 1]!.id} остались без перевода`,
      );
      for (const segment of batch) markUntranslated(segment, warnings);
      await options.onBatch?.(index + 1, batches.length, segments);
      continue;
    }

    Object.assign(glossary, payload.glossary);

    for (const segment of batch) {
      const translated = payload.items.get(segment.id);
      if (translated) {
        segment.text_ru = translated;
      } else {
        markUntranslated(segment, warnings);
      }
    }

    await options.onBatch?.(index + 1, batches.length, segments);
  }

  // Ни один пакет не поддался — дальше идти незачем: озвучивать нечего.
  if (failedBatches > 0 && failedBatches === batches.length) {
    throw new StageError('s3', `не переведён ни один из ${batches.length} пакетов`, {
      hints: [
        'Проверьте модель кнопкой «Проверить модель» в настройках',
        'Некоторые модели не держат формат ответа — выберите другую',
      ],
    });
  }
  if (failedBatches > 0) {
    warnings.push(
      `Не переведено пакетов: ${failedBatches} из ${batches.length}. ` +
        'Повторный запуск со стадии s3 переведёт их заново — стадии до неё возьмутся из кэша',
    );
    log.warn(`Не переведено пакетов: ${failedBatches} из ${batches.length}`);
  }

  if (config.translate.fit_length_pass) {
    const improved = await fitLengths(client, config, segments, usage);
    if (improved > 0) log.step(`подгонка длины: переписано реплик ${improved}`);
  }

  return {
    segments,
    stats: lengthStats(segments, cps, tolerance, floor, overhead, room),
    glossary,
    usage,
    elapsedMs: Date.now() - started,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export interface S3Result {
  segments: Segment[];
  provider: string;
  warnings: string[];
  stats: LengthStats;
  glossary: Record<string, string>;
  usage: RunUsage;
}

export async function runS3(workspace: Workspace, baseConfig: DubConfig, segments: Segment[]): Promise<S3Result> {
  const selection = await selectChatClient(baseConfig);
  const client = selection.client;
  log.step(`перевод через ${client.name}, модель ${client.model}`);

  // Длину перевода заказываем по измеренному темпу голоса, а не по умолчанию:
  // на ru_RU-irina-medium это 13.2 знака в секунду против 11.5 в настройках,
  // то есть в слот влезает на 15% больше текста, чем мы просим.
  const shape = await effectiveSpeechShape(workspace, baseConfig);
  if (Math.abs(shape.charsPerSecond - baseConfig.translate.chars_per_second) > 0.05) {
    log.step(
      `темп речи по замеру: ${shape.charsPerSecond} симв/с плюс ${shape.overheadSeconds} с на реплику ` +
        `(в настройках ${baseConfig.translate.chars_per_second} и ${baseConfig.translate.speech_overhead_seconds})`,
    );
  }
  const config: DubConfig = {
    ...baseConfig,
    translate: {
      ...baseConfig.translate,
      chars_per_second: shape.charsPerSecond,
      speech_overhead_seconds: shape.overheadSeconds,
    },
  };

  const run = await translateSegments(client, config, segments, {
    // Persist after every batch so a crash never loses completed work (SPEC §7).
    onBatch: async (done, total, partial) => {
      await workspace.writeSegments(partial);
      log.step(`пакет ${counter(done, total)} переведён`);
      log.progress(`переведено пакетов ${counter(done, total)}`, null, { done, total });
    },
  });

  const { stats } = run;
  log.step(
    `в допуске длины ±${Math.round(config.translate.length_tolerance * 100)}%: ` +
      `${stats.withinTolerance}/${stats.total} (${(stats.share * 100).toFixed(1)}%)`,
  );
  if (run.usage.requests > 0) {
    log.step(
      `запросов: ${run.usage.requests}, токенов: ${run.usage.promptTokens + run.usage.completionTokens}` +
        (run.usage.cost > 0 ? `, стоимость: ${formatCost(run.usage.cost)}` : ''),
    );
  }

  const warnings = [...selection.warnings, ...run.warnings];
  if (!stats.passed) {
    warnings.push(
      `Только ${(stats.share * 100).toFixed(1)}% реплик укладываются в слот (ТЗ FR-3 требует ≥90%). ` +
        `Длинных: ${stats.tooLong}, коротких: ${stats.tooShort}. Стадия S6 доведёт их темпом и сокращением`,
    );
  }

  await workspace.writeSegments(run.segments);
  await workspace.writeJson(workspace.file('glossary.json'), run.glossary);

  return {
    segments: run.segments,
    provider: `${client.name} / ${client.model}${selection.degraded ? ' (деградация)' : ''}`,
    warnings,
    stats,
    glossary: run.glossary,
    usage: run.usage,
  };
}
