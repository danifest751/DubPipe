import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DubConfig } from '../../config/schema.js';
import { log } from '../../core/logger.js';

/**
 * Model catalog of the gateway: lets the user pick any available model instead
 * of the default, and prices a translation run (SPEC §3.1, §3.2).
 */

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  /** Price per token in USD; zero for free models. */
  promptPrice: number;
  completionPrice: number;
  free: boolean;
}

interface RawModel {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function toNumber(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseCatalog(payload: unknown): CatalogModel[] {
  const container = payload as { data?: RawModel[] } | RawModel[];
  const raw = Array.isArray(container) ? container : (container.data ?? []);

  return raw
    .filter((model): model is RawModel & { id: string } => typeof model.id === 'string' && model.id.length > 0)
    .filter((model) => {
      // Translation needs plain text out. Models that also emit audio or images
      // (music and voice-assistant models) are not translation engines, even
      // though they technically list "text" among their outputs.
      const out = model.architecture?.output_modalities;
      if (out === undefined) return true;
      return out.includes('text') && out.every((modality) => modality === 'text');
    })
    .map((model) => {
      const promptPrice = toNumber(model.pricing?.prompt);
      const completionPrice = toNumber(model.pricing?.completion);
      return {
        id: model.id,
        name: model.name ?? model.id,
        contextLength: model.context_length ?? 0,
        promptPrice,
        completionPrice,
        free: promptPrice === 0 && completionPrice === 0,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface CatalogFilter {
  search?: string;
  freeOnly?: boolean;
  limit?: number;
}

export function filterCatalog(models: CatalogModel[], filter: CatalogFilter = {}): CatalogModel[] {
  const { search, freeOnly, limit } = filter;
  const needle = search?.toLowerCase().trim();

  let result = models;
  if (needle) {
    result = result.filter(
      (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
  }
  if (freeOnly) result = result.filter((model) => model.free);
  return limit && limit > 0 ? result.slice(0, limit) : result;
}

function catalogPath(cacheDir: string): string {
  return path.join(path.resolve(process.cwd(), cacheDir), 'models', 'catalog.json');
}

/**
 * Loads the catalog, reusing a day-old cache so `dub models list` stays instant
 * and works offline once fetched.
 */
export async function loadCatalog(config: DubConfig, force = false): Promise<CatalogModel[]> {
  const target = catalogPath(config.cache.dir);

  if (!force && existsSync(target)) {
    const info = await stat(target);
    if (Date.now() - info.mtimeMs < CACHE_TTL_MS) {
      try {
        return parseCatalog(JSON.parse(await readFile(target, 'utf8')));
      } catch {
        log.debug('кэш каталога моделей повреждён, перезагружаю');
      }
    }
  }

  const url = `${config.kilo_gateway.endpoint.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.kilo_gateway.timeout_ms);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`шлюз ответил ${response.status}`);
    const payload = await response.json();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(payload), 'utf8');
    return parseCatalog(payload);
  } finally {
    clearTimeout(timer);
  }
}

/** Cost of a run in USD, from reported usage or, failing that, catalog prices. */
export function estimateCost(
  model: CatalogModel | undefined,
  usage: { promptTokens: number; completionTokens: number; cost?: number },
): number {
  if (usage.cost !== undefined && usage.cost > 0) return usage.cost;
  if (!model) return 0;
  return usage.promptTokens * model.promptPrice + usage.completionTokens * model.completionPrice;
}

export function formatCost(usd: number): string {
  if (usd === 0) return 'бесплатно';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}
