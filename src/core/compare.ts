import type { DubConfig } from '../config/schema.js';
import { KiloGatewayClient, OllamaClient, type ChatClient } from '../providers/llm/index.js';
import { estimateCost, formatCost, loadCatalog, type CatalogModel } from '../providers/llm/catalog.js';
import { translateSegments, type LengthStats, type RunUsage } from '../stages/s3-translate.js';
import { log } from './logger.js';
import { slotOf, type Segment } from './types.js';
import { StageError } from './errors.js';

/**
 * Side-by-side translation comparison across models.
 *
 * The point is picking a model on evidence rather than reputation: the same
 * replicas go through each model, and the report puts quality signals (slot fit),
 * price and speed next to the actual Russian lines.
 */

export interface ModelComparison {
  model: string;
  ok: boolean;
  error?: string;
  stats: LengthStats;
  usage: RunUsage;
  costUsd: number;
  elapsedMs: number;
  glossary: Record<string, string>;
  lines: Array<{ id: number; slot: number; text_en: string; text_ru: string; fits: boolean }>;
}

export interface ComparisonReport {
  input: string;
  createdAt: string;
  replicaCount: number;
  models: ModelComparison[];
}

/** Builds the client for a model id; `ollama:` picks the local engine. */
export async function clientFor(config: DubConfig, modelId: string): Promise<ChatClient> {
  if (modelId.startsWith('ollama:')) {
    const local = new OllamaClient(config, modelId.slice('ollama:'.length));
    if (!(await local.available())) {
      throw new StageError('s3', `модель ${local.model} недоступна в Ollama`, {
        hints: [`ollama pull ${local.model}`],
      });
    }
    return local;
  }

  const gateway = await KiloGatewayClient.create(config, modelId);
  if (!gateway) {
    throw new StageError('s3', `не задан ключ ${config.kilo_gateway.api_key_env}`, {
      hints: [`Задайте переменную ${config.kilo_gateway.api_key_env} или сравнивайте локальные модели: ollama:<модель>`],
    });
  }
  return gateway;
}

export interface CompareOptions {
  /** Time budget per model; exceeding it fails that model, not the whole run. */
  timeoutMsPerModel?: number;
}

/**
 * Config clone used for comparison runs. A model that queues or stalls must not
 * hold up the others, so retries are dropped and the per-request timeout is
 * capped by the budget.
 */
export function comparisonConfig(config: DubConfig, budgetMs: number): DubConfig {
  return {
    ...config,
    kilo_gateway: {
      ...config.kilo_gateway,
      timeout_ms: Math.max(15_000, Math.min(config.kilo_gateway.timeout_ms, budgetMs)),
      max_retries: 1,
    },
  };
}

export async function compareModels(
  config: DubConfig,
  segments: Segment[],
  modelIds: string[],
  input: string,
  options: CompareOptions = {},
): Promise<ComparisonReport> {
  const budgetMs = options.timeoutMsPerModel ?? 180_000;
  const runConfig = comparisonConfig(config, budgetMs);
  let catalog: CatalogModel[] = [];
  try {
    catalog = await loadCatalog(config);
  } catch (error) {
    log.debug(`каталог моделей недоступен, цены будут взяты из ответов: ${(error as Error).message}`);
  }

  const results: ModelComparison[] = [];

  for (const [index, modelId] of modelIds.entries()) {
    log.stage(index + 1, modelIds.length, modelId, 'перевод для сравнения');
    const empty: RunUsage = { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 };

    try {
      const client = await clientFor(runConfig, modelId);
      const deadline = Date.now() + budgetMs;
      // Each model sees the same input, untouched by the previous run; the
      // deadline is checked between batches so a stalled model is dropped
      // instead of holding up the comparison.
      const run = await translateSegments(client, runConfig, segments, {
        onBatch: () => {
          if (Date.now() > deadline) {
            throw new Error(`превышен лимит времени ${Math.round(budgetMs / 1000)} с`);
          }
        },
      });
      const catalogEntry = catalog.find((entry) => entry.id === modelId);

      results.push({
        model: modelId,
        ok: true,
        stats: run.stats,
        usage: run.usage,
        costUsd: estimateCost(catalogEntry, run.usage),
        elapsedMs: run.elapsedMs,
        glossary: run.glossary,
        lines: run.segments.map((segment) => ({
          id: segment.id,
          slot: Number(slotOf(segment).toFixed(2)),
          text_en: segment.text_en,
          text_ru: segment.text_ru ?? '',
          fits: true,
        })),
      });

      // Mark which lines fit their slot, reusing the stats rule.
      const last = results[results.length - 1]!;
      const floor = config.translate.length_tolerance_floor_ms / 1000;
      for (const line of last.lines) {
        const estimated = line.text_ru.length / config.translate.chars_per_second;
        line.fits = Math.abs(estimated - line.slot) <= Math.max(line.slot * config.translate.length_tolerance, floor);
      }

      log.step(
        `${modelId}: в допуске ${run.stats.withinTolerance}/${run.stats.total}, ` +
          `${(run.elapsedMs / 1000).toFixed(1)} с, ${formatCost(results[results.length - 1]!.costUsd)}`,
      );
    } catch (error) {
      log.warn(`${modelId}: ${(error as Error).message}`);
      results.push({
        model: modelId,
        ok: false,
        error: (error as Error).message,
        stats: { total: 0, withinTolerance: 0, share: 0, tooLong: 0, tooShort: 0, passed: false },
        usage: empty,
        costUsd: 0,
        elapsedMs: 0,
        glossary: {},
        lines: [],
      });
    }
  }

  return {
    input,
    createdAt: new Date().toISOString(),
    replicaCount: segments.length,
    models: results,
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Summary table, best slot fit first. */
export function formatSummary(report: ComparisonReport): string {
  const rows = [...report.models].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return b.stats.share - a.stats.share;
  });

  const modelWidth = Math.max(12, ...rows.map((row) => row.model.length));
  const header =
    `${pad('модель', modelWidth)}  ${pad('в допуске', 11)}  ${pad('время', 8)}  ${pad('токены', 9)}  стоимость`;
  const lines = [header, '─'.repeat(header.length)];

  for (const row of rows) {
    if (!row.ok) {
      lines.push(`${pad(row.model, modelWidth)}  ошибка: ${row.error ?? 'неизвестно'}`);
      continue;
    }
    const fit = `${row.stats.withinTolerance}/${row.stats.total} (${Math.round(row.stats.share * 100)}%)`;
    const tokens = String(row.usage.promptTokens + row.usage.completionTokens);
    lines.push(
      `${pad(row.model, modelWidth)}  ${pad(fit, 11)}  ${pad(`${(row.elapsedMs / 1000).toFixed(1)} с`, 8)}  ` +
        `${pad(tokens, 9)}  ${formatCost(row.costUsd)}`,
    );
  }

  return lines.join('\n');
}

/** Replica-by-replica view: the part a human actually judges quality on. */
export function formatSideBySide(report: ComparisonReport): string {
  const usable = report.models.filter((model) => model.ok && model.lines.length > 0);
  if (usable.length === 0) return 'Ни одна модель не выдала перевод.';

  const reference = usable[0]!;
  const lines: string[] = [];

  for (const [index, line] of reference.lines.entries()) {
    lines.push(`[${line.id}] слот ${line.slot.toFixed(2)} с — ${line.text_en}`);
    for (const model of usable) {
      const candidate = model.lines[index];
      if (!candidate) continue;
      const mark = candidate.fits ? '✓' : '✗';
      lines.push(`    ${mark} ${pad(model.model, 34)} ${candidate.text_ru}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
