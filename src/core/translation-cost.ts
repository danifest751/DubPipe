import path from 'node:path';
import type { Workspace } from './workspace.js';

/**
 * Сколько токенов уходит на знак исходного текста — замер, а не догадка.
 *
 * Оценить стоимость перевода до запуска можно только зная это отношение, и
 * посчитать его на бумаге не выходит: в каждый запрос идут не одни реплики, а
 * ещё системная инструкция, глоссарий и соседние реплики для контекста, и всё
 * это повторяется на каждый пакет. Прикидка «запрос вдвое длиннее текста»
 * ошиблась на реальном материале в двадцать с лишним раз: третий эпизод — 1766
 * знаков исходника — по ней выходил в 1.2 цента, а стоил 27.
 *
 * Поэтому отношение измеряется на настоящих прогонах и запоминается для модели.
 * Пока замера нет, оценки нет: пустое место честнее неверного числа.
 */

export interface TokenRate {
  /** Токенов запроса на один знак исходника. */
  prompt_per_char: number;
  /** Токенов ответа на один знак исходника. */
  completion_per_char: number;
  measured_at: string;
  /** На скольких знаках получено: по одной короткой реплике верить нечему. */
  chars: number;
}

const FILE = 'translation-cost.json';

/** Замер, которому можно верить: пакетов должно быть несколько. */
const MIN_CHARS = 500;

function usable(rate: Partial<TokenRate> | undefined | null): rate is TokenRate {
  return (
    typeof rate?.prompt_per_char === 'number' &&
    typeof rate.completion_per_char === 'number' &&
    Number.isFinite(rate.prompt_per_char) &&
    Number.isFinite(rate.completion_per_char) &&
    rate.prompt_per_char > 0 &&
    rate.completion_per_char > 0 &&
    (rate.chars ?? 0) >= MIN_CHARS
  );
}

/** Запомненное отношение для этой модели; `null` — ещё не мерили. */
export async function tokenRateFor(workspace: Workspace, model: string): Promise<TokenRate | null> {
  const saved = await workspace.readJson<Record<string, Partial<TokenRate>>>(path.join(workspace.root, FILE));
  const rate = saved?.[model];
  return usable(rate) ? rate : null;
}

/**
 * Запоминает отношение по итогам прогона. Хранится рядом с калибровкой темпа
 * речи — на все записи сразу: оно зависит от модели и настроек перевода, а не
 * от конкретного фильма.
 */
export async function rememberTokenRate(
  workspace: Workspace,
  model: string,
  run: { chars: number; promptTokens: number; completionTokens: number },
): Promise<void> {
  if (run.chars < MIN_CHARS || run.promptTokens <= 0) return;
  const file = path.join(workspace.root, FILE);
  const saved = (await workspace.readJson<Record<string, TokenRate>>(file)) ?? {};
  saved[model] = {
    prompt_per_char: Number((run.promptTokens / run.chars).toFixed(4)),
    completion_per_char: Number((run.completionTokens / run.chars).toFixed(4)),
    measured_at: new Date().toISOString(),
    chars: run.chars,
  };
  await workspace.writeJson(file, saved);
}
