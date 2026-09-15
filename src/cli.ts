#!/usr/bin/env node
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { loadConfig, initConfig } from './config/load.js';
import { DubPipeError, EXIT, toExitCode } from './core/errors.js';
import { showLegalNoticeOnce } from './core/legal.js';
import { formatDuration, log } from './core/logger.js';
import { inspectCompute } from './core/compute.js';
import { runPipeline } from './core/pipeline.js';
import { STAGE_IDS, STAGE_TITLES, type StageId } from './core/types.js';
import { TOOL_VERSION, Workspace } from './core/workspace.js';
import { evaluateTimecodes, formatEvaluation, type GoldenSegment } from './core/evaluate.js';
import { compareModels, formatSideBySide, formatSummary } from './core/compare.js';
import { filterCatalog, loadCatalog } from './providers/llm/catalog.js';
import { createTtsProvider, voicesForEngine } from './providers/tts/index.js';
import { probePython } from './stages/s4-separate.js';
import { toSrt } from './util/srt.js';
import { findTool, provisionTool, TOOLS, type ToolName } from './util/tools.js';
import { run } from './util/exec.js';
import { startUiServer } from './ui/server.js';

function parseStage(value: string): StageId {
  const normalized = value.toLowerCase().startsWith('s') ? value.toLowerCase() : `s${value}`;
  if (!(STAGE_IDS as readonly string[]).includes(normalized)) {
    throw new InvalidArgumentError(`ожидается одна из стадий: ${STAGE_IDS.join(', ')}`);
  }
  return normalized as StageId;
}

const program = new Command();

program
  .name('dub')
  .description('DubPipe — автоматический дубляж видео EN→RU (только для личного просмотра)')
  .version(TOOL_VERSION);

program
  .command('process')
  .description('Обработать видеофайл или YouTube-URL')
  .argument('<input>', 'путь к файлу или YouTube-URL')
  .option('--out <file>', 'путь к итоговому файлу')
  .option('--out-dir <dir>', 'папка для итога; имя файла — по имени входа')
  .option('--subtitles', 'также записать субтитры (два файла SRT)')
  .option('--config <path>', 'путь к config.yaml')
  .option('--model <id>', 'модель перевода, минуя config.yaml')
  .option('--from-stage <id>', 'начать со стадии (s1…s7)', parseStage)
  .option('--to-stage <id>', 'закончить стадией (s1…s7)', parseStage)
  .option('--yes', 'не переспрашивать на длинных входах')
  .action(async (input: string, options) => {
    await showLegalNoticeOnce();
    const { config, source } = await loadConfig(options.config);
    log.debug(`конфигурация: ${source}`);
    if (options.model) {
      config.translate.model = options.model as string;
      log.info(`Модель перевода: ${config.translate.model} (из --model)`);
    }
    log.info(`Профиль: ${config.profile}`);

    const started = Date.now();
    const report = await runPipeline({
      input,
      config,
      ...(options.out ? { out: options.out as string } : {}),
      ...(options.outDir ? { outDir: options.outDir as string } : {}),
      ...(options.subtitles ? { subtitles: true } : {}),
      ...(options.fromStage ? { fromStage: options.fromStage as StageId } : {}),
      ...(options.toStage ? { toStage: options.toStage as StageId } : {}),
    });

    log.info('');
    log.success(`Готово за ${formatDuration(Date.now() - started)}`);
    log.info(`Рабочий каталог: ${report.workspace}`);
    for (const outcome of report.outcomes) {
      const mark = outcome.cached ? 'кэш' : `${outcome.provider}, ${formatDuration(outcome.durationMs)}`;
      log.info(`  ${outcome.stage.toUpperCase()} ${STAGE_TITLES[outcome.stage]} — ${mark}`);
    }
    if (report.warnings.length) {
      log.info('');
      for (const warning of report.warnings) log.warn(warning);
    }
    if (report.output) log.success(`Итог: ${report.output}`);
  });

const configCommand = program.command('config').description('Управление конфигурацией');
configCommand
  .command('init')
  .description('Создать config.yaml из примера')
  .option('--force', 'перезаписать существующий файл')
  .action(async (options) => {
    const target = await initConfig(process.cwd(), options.force === true);
    log.success(`Создан ${target}`);
    log.info('Отредактируйте его под себя; справка по полям — в комментариях файла');
  });

const cacheCommand = program.command('cache').description('Управление кэшем стадий');
cacheCommand
  .command('clear')
  .description('Очистить кэш целиком или для одного входа')
  .argument('[input]', 'путь или URL; без аргумента очищается всё')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (input: string | undefined, options) => {
    const { config } = await loadConfig(options.config);
    if (input) {
      const workspace = await Workspace.open(input, config);
      await workspace.clear();
      log.success(`Кэш очищен: ${workspace.dir}`);
    } else {
      const removed = await Workspace.clearAll(config);
      log.success(`Очищено рабочих каталогов: ${removed} (бинарники и модели сохранены)`);
    }
  });

program
  .command('ui')
  .description('Запустить графический интерфейс (локально, ТЗ §16)')
  .option('--port <n>', 'порт; по умолчанию свободный', (value) => Number(value))
  .option('--no-open', 'не открывать браузер')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    await showLegalNoticeOnce();
    const server = await startUiServer({
      ...(options.port ? { port: options.port as number } : {}),
      ...(options.config ? { configPath: options.config as string } : {}),
    });

    log.success(`Интерфейс доступен: ${server.url}`);
    log.info('Ссылка содержит одноразовый токен доступа и действует до остановки процесса.');
    log.info('Сервер слушает только 127.0.0.1 — извне он недоступен. Остановить: Ctrl+C');

    if (options.open !== false) {
      const opener =
        process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      // explorer возвращает ненулевой код даже при успехе — игнорируем.
      run(opener, [server.url], { timeoutMs: 15_000 }).catch(() => undefined);
    }

    const shutdown = async () => {
      log.info('Остановка интерфейса…');
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });

program
  .command('doctor')
  .description('Проверить внешние зависимости')
  .option('--fetch', 'загрузить недостающие компоненты в рабочий каталог')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    const { config } = await loadConfig(options.config);
    const toolsDir = path.resolve(process.cwd(), config.cache.dir, 'tools');
    let missingRequired = 0;

    for (const name of Object.keys(TOOLS) as ToolName[]) {
      const spec = TOOLS[name];
      let found = await findTool(name, toolsDir);

      if (!found && options.fetch && spec.fetch) {
        try {
          found = await provisionTool(name, toolsDir);
        } catch (error) {
          log.warn(`${name}: загрузка не удалась — ${(error as Error).message}`);
        }
      }

      if (found) {
        log.success(`${name.padEnd(12)} ${found.path} ${found.source === 'local' ? '(локально)' : '(в PATH)'}`);
      } else {
        if (spec.required) missingRequired++;
        const level = spec.required ? log.error.bind(log) : log.warn.bind(log);
        level(`${name.padEnd(12)} не найден — ${spec.purpose}`);
        log.info(`             установка: ${spec.installHint}`);
      }
    }

    // Python is only needed for the optional separation stage (SPEC §0.3).
    const python = await probePython();
    if (python.available) {
      log.success(`${'python'.padEnd(12)} ${python.executable} (numpy, onnxruntime) — отделение голоса доступно`);
    } else if (config.separation.enabled) {
      log.warn(`${'python'.padEnd(12)} ${python.missing.join(', ')} — стадия S4 откатится на приглушение оригинала`);
      log.info(`             установка: ${python.executable ?? 'python'} -m pip install numpy onnxruntime`);
    } else {
      log.info(`${'python'.padEnd(12)} не требуется (separation.enabled: false)`);
    }

    const keySet = Boolean(process.env[config.kilo_gateway.api_key_env]);
    if (config.profile === 'hybrid') {
      if (keySet) log.success(`ключ ${config.kilo_gateway.api_key_env} задан — перевод пойдёт через шлюз`);
      else log.warn(`ключ ${config.kilo_gateway.api_key_env} не задан — перевод деградирует до локального (ТЗ §15.2)`);
    }

    // Карта вычислений: где что считается. Вопрос задают чаще всего после
    // установки, а ответ до сих пор можно было добыть только из журнала прогона.
    const compute = await inspectCompute(config);
    log.info('');
    log.info(`Видеоадаптеры: ${compute.adapters.length > 0 ? compute.adapters.join(', ') : 'не найдены'}`);
    for (const stage of compute.stages) {
      log.info(`  ${stage.stage.padEnd(20)} ${stage.where}${stage.detail ? ` — ${stage.detail}` : ''}`);
    }
    for (const hint of compute.hints) log.info(`  → ${hint}`);
    log.info('');

    if (missingRequired > 0) {
      log.error(`Отсутствуют обязательные зависимости: ${missingRequired}`);
      log.info('Загрузить автоматически: dub doctor --fetch');
      process.exitCode = EXIT.MISSING_DEPENDENCY;
    } else {
      log.success('Все обязательные зависимости на месте');
    }
  });

program
  .command('export-srt')
  .description('Выгрузить субтитры для ручной правки')
  .argument('<input>', 'путь или URL, который уже обрабатывался')
  .option('--lang <lang>', 'en или ru', 'en')
  .option('--out <file>', 'куда сохранить')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (input: string, options) => {
    const { config } = await loadConfig(options.config);
    const workspace = await Workspace.open(input, config);
    const segments = await workspace.readSegments();
    if (!segments || segments.length === 0) {
      log.error(`Нет сохранённых реплик для ${input}`);
      log.info(`Сначала выполните: dub process "${input}" --to-stage s2`);
      process.exitCode = EXIT.STAGE_ERROR;
      return;
    }
    const lang = options.lang === 'ru' ? 'ru' : 'en';
    const target = (options.out as string | undefined) ?? workspace.file(`transcript.${lang}.srt`);
    await writeFile(target, toSrt(segments, lang), 'utf8');
    log.success(`Субтитры сохранены: ${target}`);
  });

program
  .command('evaluate')
  .description('Сверить таймкоды с эталонной разметкой (критерий M1)')
  .argument('<input>', 'путь или URL, который уже обрабатывался')
  .option('--golden <file>', 'файл эталонной разметки', 'tests/fixtures/golden.json')
  .option('--tolerance <ms>', 'допуск в миллисекундах', '250')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (input: string, options) => {
    const { config } = await loadConfig(options.config);
    const workspace = await Workspace.open(input, config);
    const segments = await workspace.readSegments();
    if (!segments?.length) {
      log.error(`Нет сохранённых реплик для ${input}`);
      process.exitCode = EXIT.STAGE_ERROR;
      return;
    }

    const golden = JSON.parse(await readFile(options.golden as string, 'utf8')) as {
      segments: GoldenSegment[];
      tolerance_ms?: number;
    };
    const tolerance = Number(options.tolerance) || golden.tolerance_ms || 250;
    const report = evaluateTimecodes(golden.segments, segments, tolerance);

    for (const match of report.matches) {
      if (!match.actual) {
        log.error(`${match.golden.start.toFixed(2)}–${match.golden.end.toFixed(2)} — не распознана`);
        continue;
      }
      const ok = Math.abs(match.startDeviationMs!) <= tolerance && Math.abs(match.endDeviationMs!) <= tolerance;
      const line =
        `${match.golden.start.toFixed(2)}–${match.golden.end.toFixed(2)} → ` +
        `начало ${match.startDeviationMs! >= 0 ? '+' : ''}${match.startDeviationMs} мс, ` +
        `конец ${match.endDeviationMs! >= 0 ? '+' : ''}${match.endDeviationMs} мс` +
        (match.group.length > 1 ? ` (реплик: ${match.group.length})` : '');
      if (ok) log.success(line);
      else log.error(line);
    }

    log.info('');
    for (const line of formatEvaluation(report).split(/\r?\n/)) log.info(line);
    if (!report.passed) process.exitCode = EXIT.STAGE_ERROR;
  });

program
  .command('models')
  .description('Список моделей перевода, доступных в шлюзе')
  .option('--search <text>', 'фильтр по идентификатору или названию')
  .option('--free', 'только бесплатные модели')
  .option('--limit <n>', 'сколько строк показать', '30')
  .option('--refresh', 'обновить кэш каталога')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    const { config } = await loadConfig(options.config);
    const catalog = await loadCatalog(config, options.refresh === true);
    const limit = Number(options.limit) || 30;
    const found = filterCatalog(catalog, {
      ...(options.search ? { search: options.search as string } : {}),
      freeOnly: options.free === true,
      limit,
    });

    log.info(`Моделей в каталоге: ${catalog.length}, показано: ${found.length}`);
    log.info('');
    for (const model of found) {
      const price = model.free
        ? 'бесплатно'
        : `$${(model.promptPrice * 1e6).toFixed(2)}/$${(model.completionPrice * 1e6).toFixed(2)} за 1M токенов`;
      const context = model.contextLength ? `${Math.round(model.contextLength / 1000)}K` : '—';
      log.info(`  ${model.id}`);
      log.info(`      ${model.name} · контекст ${context} · ${price}`);
    }

    log.info('');
    log.info('Выбрать модель: translate.model в config.yaml, либо dub process --model <id>');
    log.info('Сравнить качество: dub compare <input> --models <id1>,<id2>');
  });

program
  .command('compare')
  .description('Сравнить качество перевода на нескольких моделях')
  .argument('<input>', 'путь или URL, для которого уже выполнена стадия s2')
  .requiredOption('--models <list>', 'модели через запятую; локальные — с префиксом ollama:')
  .option('--limit <n>', 'сколько первых реплик взять для сравнения')
  .option('--apply <model>', 'записать перевод выбранной модели в segments.json')
  .option('--timeout <seconds>', 'лимит времени на одну модель', '180')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (input: string, options) => {
    const { config } = await loadConfig(options.config);
    const workspace = await Workspace.open(input, config);
    const stored = await workspace.readSegments();
    if (!stored?.length) {
      log.error(`Нет распознанных реплик для ${input}`);
      log.info(`Сначала выполните: dub process "${input}" --to-stage s2`);
      process.exitCode = EXIT.STAGE_ERROR;
      return;
    }

    const limit = Number(options.limit) || 0;
    const segments = limit > 0 ? stored.slice(0, limit) : stored;
    const models = (options.models as string)
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);

    if (models.length < 2) {
      log.warn('Для сравнения укажите хотя бы две модели через запятую');
    }
    log.info(`Реплик: ${segments.length}, моделей: ${models.length}`);

    const report = await compareModels(config, segments, models, input, {
      timeoutMsPerModel: (Number(options.timeout) || 180) * 1000,
    });
    await workspace.writeJson(workspace.file('compare.json'), report);

    log.info('');
    for (const line of formatSummary(report).split(/\r?\n/)) log.info(line);
    log.info('');
    for (const line of formatSideBySide(report).split(/\r?\n/)) log.info(line);

    const applyTo = options.apply as string | undefined;
    if (applyTo) {
      const chosen = report.models.find((model) => model.model === applyTo && model.ok);
      if (!chosen) {
        log.error(`Модель ${applyTo} не участвовала в сравнении или завершилась ошибкой`);
        process.exitCode = EXIT.STAGE_ERROR;
        return;
      }
      const byId = new Map(chosen.lines.map((line) => [line.id, line.text_ru]));
      for (const segment of stored) {
        const text = byId.get(segment.id);
        if (text) segment.text_ru = text;
      }
      await workspace.writeSegments(stored);
      log.success(`Перевод модели ${applyTo} записан в segments.json`);
      log.info(`Чтобы кэш совпал, укажите в config.yaml:  translate.model: ${applyTo}`);
    } else {
      log.info(`Отчёт сохранён: ${workspace.file('compare.json')}`);
      log.info('Применить понравившийся вариант: та же команда с --apply <модель>');
    }
  });

const voicesCommand = program.command('voices').description('Голоса активного TTS-движка');
voicesCommand
  .command('list')
  .description('Показать доступные голоса')
  .option('--demo', 'синтезировать образец каждого голоса')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    const { config } = await loadConfig(options.config);
    log.info(`Движок синтеза: ${config.tts.engine}`);
    log.info('');

    for (const voice of voicesForEngine(config.tts.engine)) {
      const assigned = Object.entries(config.tts.voice_map)
        .filter(([, name]) => name === voice.name)
        .map(([speaker]) => speaker);
      const marks = [
        voice.name === config.tts.default_voice ? 'по умолчанию' : '',
        assigned.length ? `назначен: ${assigned.join(', ')}` : '',
      ].filter(Boolean);
      log.info(`  ${voice.name}  (${voice.gender}) — ${voice.note}${marks.length ? ` · ${marks.join(' · ')}` : ''}`);
    }

    log.info('');
    log.info('Назначение голосов — поля tts.default_voice и tts.voice_map в config.yaml');

    if (options.demo) {
      const workspace = await Workspace.open('voice-demo', config);
      const provider = createTtsProvider(workspace, config) as { sample?: PiperSample };
      if (!provider.sample) {
        log.warn('Текущий движок не умеет синтезировать образцы');
        return;
      }
      for (const voice of voicesForEngine(config.tts.engine)) {
        const target = path.resolve(`demo-${voice.name}.wav`);
        await provider.sample(voice.name, 'Проверка голоса. Так будет звучать дубляж.', target);
        log.success(`образец: ${target}`);
      }
    }
  });

type PiperSample = (voice: string, text: string, outputPath: string) => Promise<unknown>;

function reportError(error: unknown): void {
  if (error instanceof DubPipeError) {
    log.error(error.message);
    for (const hint of error.hints) log.info(`  → ${hint}`);
  } else {
    log.error((error as Error).message ?? String(error));
    if (process.env['DEBUG']) log.debug(String((error as Error).stack));
  }
  process.exitCode = toExitCode(error);
}

program.parseAsync(process.argv).catch(reportError);
