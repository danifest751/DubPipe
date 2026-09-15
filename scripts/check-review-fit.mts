/**
 * Что даёт рецензия на одном и том же черновике: укладка до и после.
 *
 * Полный прогон S3 для этого не годится. Локальный перевод от запуска к запуску
 * гуляет — на третьем эпизоде те же настройки дали 31.6% и 42.1% укладки, —
 * и разница между двумя прогонами оказывается про случайность, а не про
 * рецензию. Поэтому черновик берётся готовый и рецензируется как есть.
 *
 * Запуск (из каталога с config.yaml и .dubpipe):
 *   npx tsx scripts/check-review-fit.mts "<путь к видео>" <модель рецензента>
 *       [--share 0.9] [--checks gender,glossary,meaning] [--out <файл>]
 *
 * `--checks` оставляет включёнными только названные проверки: так видно, что
 * рецензия находит, когда её не занимают длиной.
 *
 * Модель рецензента — по правилу `dub compare`: `ollama:qwen3:14b` локально,
 * `anthropic/claude-sonnet-4.5` через шлюз.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/load.js';
import { Workspace } from '../src/core/workspace.js';
import { clientFor } from '../src/providers/llm/index.js';
import { lengthStats, reviewTranslation, roomFor, type RunUsage } from '../src/stages/s3-translate.js';
import { effectiveSpeechShape } from '../src/core/calibration.js';
import type { Segment, StageWarning } from '../src/core/types.js';
import { warningText } from '../src/core/types.js';

const [input, reviewer] = process.argv.slice(2);
if (!input || !reviewer) {
  console.error('нужны: путь к видео и модель рецензента (ollama:<модель> или имя из каталога шлюза)');
  process.exit(2);
}
const shareAt = process.argv.indexOf('--share');
const checksAt = process.argv.indexOf('--checks');
const onlyChecks = checksAt > 0 ? new Set((process.argv[checksAt + 1] ?? '').split(',').map((name) => name.trim())) : null;
const outAt = process.argv.indexOf('--out');

const { config: loaded } = await loadConfig();
const config = {
  ...loaded,
  translate: {
    ...loaded.translate,
    review: {
      ...loaded.translate.review,
      enabled: true,
      model: reviewer,
      ...(shareAt > 0 ? { max_changes_share: Number(process.argv[shareAt + 1]) } : {}),
      ...(onlyChecks
        ? {
            checks: Object.fromEntries(
              Object.keys(loaded.translate.review.checks).map((name) => [name, onlyChecks.has(name)]),
            ) as typeof loaded.translate.review.checks,
          }
        : {}),
    },
  },
};

const workspace = await Workspace.open(input, config);
/*
 * Темп речи берётся замеренный, а не из настроек.
 *
 * Стадия так и делает: на этом эпизоде калибровка даёт 13.2 симв/с против 11.5
 * в файле. С чужой меркой скрипт объявлял длинными 60 реплик из 76 там, где
 * конвейер видит одну, и рецензия получала задание сокращать то, что и так
 * укладывается.
 */
const shape = await effectiveSpeechShape(workspace, config);
config.translate.chars_per_second = shape.charsPerSecond;
config.translate.speech_overhead_seconds = shape.overheadSeconds;
console.log(`темп речи: ${shape.charsPerSecond} симв/с плюс ${shape.overheadSeconds} с на реплику`);
const draft = (await workspace.readSegments()) ?? [];
if (draft.length === 0) {
  console.error('в рабочем каталоге нет переведённых реплик: сначала выполните S3');
  process.exit(2);
}
const glossary = JSON.parse(await readFile(workspace.file('glossary.json'), 'utf8').catch(() => '{}')) as Record<string, string>;

const fit = (segments: Segment[]): string => {
  const stats = lengthStats(
    segments,
    config.translate.chars_per_second,
    config.translate.length_tolerance,
    config.translate.length_tolerance_floor_ms / 1000,
    config.translate.speech_overhead_seconds,
    roomFor(config, segments),
  );
  return `${stats.withinTolerance}/${stats.total} (${(stats.share * 100).toFixed(1)}%), длинных ${stats.tooLong}, коротких ${stats.tooShort}`;
};

console.log('до рецензии:  ', fit(draft));
const usage: RunUsage = { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 };
const warnings: StageWarning[] = [];
const started = Date.now();
const client = await clientFor(config, reviewer);
const reviewed = await reviewTranslation(client, config, draft, workspace, glossary, usage, warnings);
console.log('после рецензии:', fit(reviewed));
console.log(
  `${client.name} / ${client.model}: ${((Date.now() - started) / 1000).toFixed(0)} с, ` +
    `запросов ${usage.requests}, токенов ${usage.promptTokens + usage.completionTokens}, стоимость $${usage.cost.toFixed(4)}`,
);
for (const warning of warnings) console.log('  !', warningText(warning));
console.log(`переписано реплик: ${draft.filter((line, index) => (line.text_ru ?? '') !== (reviewed[index]?.text_ru ?? '')).length} из ${draft.length}`);
if (outAt > 0 && process.argv[outAt + 1]) await writeFile(process.argv[outAt + 1]!, JSON.stringify(reviewed, null, 2), 'utf8');
