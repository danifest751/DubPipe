import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import { ConfigError } from '../core/errors.js';
import { configSchema, type DubConfig, type Profile, LOCAL_DEFAULT_MODEL } from './schema.js';

export const DEFAULT_CONFIG_NAME = 'config.yaml';

/** Package root, resolved from this module so it works from src/ and dist/ alike. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function exampleConfigPath(): string {
  return path.join(packageRoot(), 'config.yaml.example');
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies profile-driven provider choices without clobbering anything the user
 * wrote explicitly: only fields absent from the raw document are filled in.
 */
function applyProfile(raw: Record<string, unknown>): Record<string, unknown> {
  const profile = (raw['profile'] as Profile | undefined) ?? 'hybrid';
  const translate = { ...((raw['translate'] as Record<string, unknown> | undefined) ?? {}) };
  if (translate['engine'] === undefined) {
    translate['engine'] = profile === 'offline' ? 'ollama' : 'kilo-gateway';
  }
  /*
   * Имя модели тоже зависит от движка, и его тоже надо подставить.
   *
   * Профиль переключал движок на Ollama, а `translate.model` оставался именем
   * из каталога шлюза — `anthropic/claude-sonnet-4.5`. Ollama такого не знает,
   * и офлайн-профиль из коробки падал на «модель не установлена». Берём то же
   * имя, что стоит запасным для локального пути: там оно осмысленное.
   */
  if (translate['engine'] === 'ollama' && translate['model'] === undefined) {
    translate['model'] = translate['fallback_model'] ?? LOCAL_DEFAULT_MODEL;
  }
  /*
   * Финальная рецензия перевода — по профилю, а не одним значением на всех.
   *
   * Она стоит второго прохода по всему тексту, и вопрос «окупается ли» решается
   * тем, кто рецензирует. Облачная модель нашла на испорченном эпизоде 13 ошибок
   * и все 13 были приняты — за 18 с и за долю стоимости самого перевода.
   * Локальная за 133 с нашла одну, и та оказалась сочинением на свободную тему.
   * Поэтому hybrid включает рецензию, offline — нет. Явно написанное в настройках
   * сильнее: подставляем только то, чего в документе нет.
   */
  const review = { ...((translate['review'] as Record<string, unknown> | undefined) ?? {}) };
  if (review['enabled'] === undefined) review['enabled'] = profile !== 'offline';
  translate['review'] = review;
  return { ...raw, profile, translate };
}

/** Renders a zod issue as "поле: проблема (получено: X)" (SPEC §5.3). */
function describeIssue(issue: z.ZodIssue): string {
  const field = issue.path.length ? issue.path.join('.') : '(корень)';
  let detail = issue.message;

  switch (issue.code) {
    case z.ZodIssueCode.invalid_enum_value:
      detail = `допустимые значения: ${issue.options.map((o) => JSON.stringify(o)).join(', ')}; получено ${JSON.stringify(issue.received)}`;
      break;
    case z.ZodIssueCode.too_small:
      detail = `значение должно быть ${issue.inclusive ? '≥' : '>'} ${String(issue.minimum)}`;
      break;
    case z.ZodIssueCode.too_big:
      detail = `значение должно быть ${issue.inclusive ? '≤' : '<'} ${String(issue.maximum)}`;
      break;
    case z.ZodIssueCode.invalid_type:
      detail = `ожидается ${issue.expected}, получено ${issue.received}`;
      break;
    case z.ZodIssueCode.unrecognized_keys:
      detail = `неизвестные поля: ${issue.keys.join(', ')}`;
      break;
    default:
      break;
  }
  return `  ${field}: ${detail}`;
}

export function parseConfig(raw: unknown, source: string): DubConfig {
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`Конфигурация ${source} должна быть YAML-объектом`);
  }
  const result = configSchema.safeParse(applyProfile(raw as Record<string, unknown>));
  if (!result.success) {
    const lines = result.error.issues.map(describeIssue).join('\n');
    throw new ConfigError(`Ошибка конфигурации (${source}):\n${lines}`, [
      'Справка по полям — ТЗ §5.3; пример — config.yaml.example',
    ]);
  }
  return result.data;
}

/**
 * Loads config.yaml. A missing file is not an error: defaults (hybrid profile)
 * are used so `dub process` works out of the box.
 */
export async function loadConfig(configPath?: string): Promise<{ config: DubConfig; source: string }> {
  const target = configPath ?? path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);

  if (!(await exists(target))) {
    if (configPath) {
      throw new ConfigError(`Файл конфигурации не найден: ${target}`, [
        'Создайте его командой: dub config init',
      ]);
    }
    return { config: parseConfig({}, 'значения по умолчанию'), source: 'значения по умолчанию' };
  }

  let text: string;
  try {
    text = await readFile(target, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Не удалось прочитать ${target}: ${(cause as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (cause) {
    throw new ConfigError(`Некорректный YAML в ${target}: ${(cause as Error).message}`);
  }

  return { config: parseConfig(doc, target), source: target };
}

/** `dub config init` (SPEC §6). */
export async function initConfig(targetDir: string, force = false): Promise<string> {
  const target = path.join(targetDir, DEFAULT_CONFIG_NAME);
  if ((await exists(target)) && !force) {
    throw new ConfigError(`${target} уже существует`, ['Перезаписать: dub config init --force']);
  }
  const example = exampleConfigPath();
  if (!(await exists(example))) {
    throw new ConfigError(`Не найден шаблон ${example}`);
  }
  await writeFile(target, await readFile(example, 'utf8'), 'utf8');
  return target;
}
