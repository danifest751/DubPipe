import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadConfig, parseConfig, exampleConfigPath, DEFAULT_CONFIG_NAME } from '../config/load.js';
import type { DubConfig } from '../config/schema.js';
import { DubPipeError } from '../core/errors.js';
import { log, type LogRecord } from '../core/logger.js';
import { progress, type ProgressEvent } from '../core/progress.js';
import { LEGAL_NOTICE } from '../core/legal.js';
import { runPipeline } from '../core/pipeline.js';
import { STAGE_IDS, STAGE_TITLES, type Segment, type StageId } from '../core/types.js';
import { Workspace, TOOL_VERSION } from '../core/workspace.js';
import { compareModels } from '../core/compare.js';
import { filterCatalog, loadCatalog } from '../providers/llm/catalog.js';
import { voicesForEngine } from '../providers/tts/voices.js';
import { SILERO_MODEL } from '../providers/tts/silero-voices.js';
import { createTtsProvider } from '../providers/tts/index.js';
import { KiloGatewayClient } from '../providers/llm/gateway.js';
import { probePython } from '../stages/s4-separate.js';
import { installDiarization, probeDiarization, resetDiarizationProbe } from '../providers/diarization/pyannote.js';
import { applyLogRecord, finishStages, type JobStage } from './job-progress.js';
import { checkModel } from '../core/model-check.js';
import { deviceOptions, type DeviceOptions } from '../core/compute.js';
import { detectHardware } from '../providers/asr/accel.js';
import {
  cueProblems,
  formatSrt,
  optionsForLanguage,
  planCues,
  subtitleFileName,
  subtitleOptionsFrom,
  type Cue,
} from '../stages/subtitles.js';
import { languageProfile, LANGUAGE_PROFILES } from '../core/languages.js';
import { message, normalizeLanguage, type UiLanguage } from '../core/i18n.js';
import { cancellation, isCancelled } from '../core/cancel.js';
import { applyOverrides, EMPTY_OVERRIDES, normalizeOverrides, planReview } from '../core/overrides.js';
import { defaultOutputName, isDubbedName, resolveOutputPath } from '../stages/s7-mix.js';
import { fitRuler } from '../stages/s3-translate.js';
import { ensureWhisperModel, whisperModelPath } from '../providers/asr/whispercpp.js';
import { ensureVadModel as ensureSileroVad } from '../providers/vad/silero.js';
import { ensureVoice } from '../providers/tts/voices.js';
import { findTool, provisionTool, TOOLS, type ToolName } from '../util/tools.js';
import { sha256 } from '../util/hash.js';

/**
 * Local HTTP API behind the web interface (SPEC §16).
 *
 * The core knows nothing about this layer, and this layer holds no pipeline
 * logic — it only exposes what the CLI already does, so the desktop shell stays
 * replaceable (SPEC §16.2).
 *
 * Security (SPEC §16.5, §16.6): loopback only, a one-time token per launch, and
 * no path from a request is ever read or executed outside the workspace.
 */

/** Расширения, которые конвейер принимает на вход (ТЗ FR-1). */
const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts', '.flv',
  '.mp3', '.m4a', '.wav', '.opus', '.ogg', '.flac', '.aac',
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml',
};

interface JobState {
  id: string;
  input: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  /** Что делаем: полный дубляж или только субтитры. */
  mode: 'dub' | 'subtitles';
  startedAt: string;
  finishedAt: string | null;
  stages: JobStage[];
  warnings: string[];
  output: string | null;
  error: string | null;
  /** Файлы субтитров, записанные задачей. */
  subtitles?: Array<{ lang: string; kind: 'source' | 'target'; path: string; cues: number }>;
}

export interface UiServerOptions {
  port?: number;
  configPath?: string;
}

export interface UiServerHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

function publicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'public'), path.resolve(here, '..', '..', 'src', 'ui', 'public')];
  return candidates.find((candidate) => existsSync(path.join(candidate, 'index.html'))) ?? candidates[0]!;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // Segment lists can be large, but nothing legitimate approaches this.
    if (size > 32 * 1024 * 1024) throw new Error('тело запроса слишком велико');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}


const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Ключ, по ошибке вставленный в поле имени переменной.
 *
 * С таким файлом настроек программа не должна ни падать, ни показывать токен
 * на экране: значение переносится в хранилище ключей под штатным именем,
 * а в файл возвращается имя переменной. Делается до разбора конфигурации —
 * иначе валидатор отверг бы файл, и пользователь остался бы у закрытой двери.
 */
async function healMisplacedKey(configPath: string, cacheRoot: string): Promise<string | null> {
  if (!existsSync(configPath)) return null;
  const text = await readFile(configPath, 'utf8');
  const doc = YAML.parseDocument(text);
  const value = doc.getIn(['kilo_gateway', 'api_key_env']);
  if (typeof value !== 'string' || ENV_NAME.test(value)) return null;

  const envName = 'KILO_API_KEY';
  const secretsPath = path.join(cacheRoot, 'secrets.json');
  let saved: Record<string, string> = {};
  try {
    if (existsSync(secretsPath)) saved = JSON.parse(await readFile(secretsPath, 'utf8'));
  } catch {
    saved = {};
  }
  // Секрет, сохранённый под именем-токеном, тоже переезжает под штатное имя.
  delete saved[value];
  saved[envName] = value;
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(secretsPath, JSON.stringify(saved, null, 2), 'utf8');

  doc.setIn(['kilo_gateway', 'api_key_env'], envName);
  await writeFile(configPath, doc.toString(), 'utf8');
  return value;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const token = randomBytes(24).toString('hex');

  // Служебный каталог нужен до разбора конфигурации: туда переезжает ключ,
  // если его вставили не в то поле.
  const provisionalConfigPath = options.configPath ?? path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);
  const healed = await healMisplacedKey(provisionalConfigPath, path.resolve(process.cwd(), '.dubpipe'));
  if (healed) {
    log.warn('В настройках вместо имени переменной был вставлен сам ключ — перенёс его в хранилище ключей');
    process.env['KILO_API_KEY'] = healed;
  }

  const { config: initialConfig } = await loadConfig(options.configPath);
  let config: DubConfig = initialConfig;

  const cacheRoot = path.resolve(process.cwd(), config.cache.dir);
  const assets = publicDir();

  /**
   * Рабочая папка пользователя — та, где лежат исходные видео.
   * Хранится рядом с кэшем, чтобы выбор переживал перезапуск, и расширяет
   * список путей, которые разрешено отдавать плееру (ТЗ §16.6: «рабочий
   * каталог и выбранный вход»).
   */
  const uiStatePath = path.join(cacheRoot, 'ui-state.json');
  let workingDir: string | null = null;
  try {
    if (existsSync(uiStatePath)) {
      const saved = JSON.parse(await readFile(uiStatePath, 'utf8')) as { workingDir?: string };
      if (saved.workingDir && existsSync(saved.workingDir)) workingDir = saved.workingDir;
    }
  } catch {
    // Повреждённый файл состояния не должен мешать запуску интерфейса.
  }

  const saveUiState = async (): Promise<void> => {
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(uiStatePath, JSON.stringify({ workingDir }, null, 2), 'utf8');
  };


  /**
   * Ключ, введённый в интерфейсе. Хранится отдельно от config.yaml (его можно
   * показывать и пересылать), применяется сразу через переменную окружения —
   * ядро по-прежнему читает ключ только оттуда, перезапуск не нужен.
   */
  const secretsPath = path.join(cacheRoot, 'secrets.json');
  const loadSecrets = async (): Promise<void> => {
    try {
      if (!existsSync(secretsPath)) return;
      const saved = JSON.parse(await readFile(secretsPath, 'utf8')) as Record<string, string>;
      // Все сохранённые секреты (ключ шлюза, токен Hugging Face) уходят в
      // окружение под своими именами; уже заданная переменная не перекрывается.
      for (const [name, value] of Object.entries(saved)) {
        if (value && ENV_NAME.test(name) && !process.env[name]) process.env[name] = value;
      }
    } catch {
      // Битый файл секретов не должен мешать запуску.
    }
  };
  await loadSecrets();

  const saveSecret = async (name: string, value: string | null): Promise<void> => {
    let saved: Record<string, string> = {};
    try {
      if (existsSync(secretsPath)) saved = JSON.parse(await readFile(secretsPath, 'utf8'));
    } catch {
      saved = {};
    }
    if (value) saved[name] = value;
    else delete saved[name];
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(secretsPath, JSON.stringify(saved, null, 2), 'utf8');
    if (value) process.env[name] = value;
    else delete process.env[name];
  };

  const secretStatus = (envName: string) => {
    const value = process.env[envName] ?? '';
    return {
      env: envName,
      set: value.length > 0,
      // Показываем только края: этого достаточно, чтобы узнать свой ключ.
      masked: value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value ? '••••' : '',
    };
  };
  const keyStatus = () => secretStatus(config.kilo_gateway.api_key_env);
  const hfTokenStatus = () => secretStatus(config.asr.diarization.hf_token_env);

  /**
   * Точечное сохранение настроек с сохранением комментариев файла: YAML
   * разбирается как документ, и меняются только затронутые значения.
   */
  const configTarget = () => options.configPath ?? path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);

  const applyConfigValues = async (values: Record<string, unknown>) => {
    const target = configTarget();
    const text = existsSync(target) ? await readFile(target, 'utf8') : await readFile(exampleConfigPath(), 'utf8');
    const doc = YAML.parseDocument(text);

    for (const [dotted, value] of Object.entries(values)) {
      const keys = dotted.split('.');
      if (value === null || value === undefined) doc.deleteIn(keys);
      else doc.setIn(keys, value);
    }

    const next = doc.toString();
    const parsed = parseConfig(YAML.parse(next), 'интерфейс');
    await writeFile(target, next, 'utf8');
    config = parsed;
    return parsed;
  };

  let job: JobState | null = null;
  let cancelRequested = false;
  /** Итоговые файлы открытых проектов: их можно отдавать плееру и после перезапуска. */
  const knownOutputs = new Set<string>();
  let deviceCache: DeviceOptions | null = null;
  const clients = new Set<ServerResponse>();
  const history: LogRecord[] = [];

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(payload);
  };

  log.subscribe((record) => {
    // Записи о ходе стадии — только для полосы прогресса; в журнал не идут,
    // там ту же историю рассказывают обычные строки.
    if (record.kind === 'progress') {
      if (job && applyLogRecord(job.stages, record)) broadcast('job', job);
      return;
    }
    history.push(record);
    if (history.length > 500) history.shift();
    if (job && applyLogRecord(job.stages, record)) broadcast('job', job);
    broadcast('log', record);
  });

  progress.subscribe((event: ProgressEvent) => broadcast('progress', event));

  /**
   * Разрешено отдавать только то, что относится к работе: артефакты кэша,
   * итог текущей задачи и исходники из выбранной пользователем папки.
   * Всё остальное — отказ (ТЗ §16.6).
   */
  const safeMediaPath = (raw: string): string | null => {
    const resolved = path.resolve(raw);
    const under = (root: string | null) =>
      root !== null && (resolved === root || resolved.startsWith(root + path.sep));

    const allowed =
      under(cacheRoot) ||
      under(workingDir) ||
      knownOutputs.has(resolved) ||
      (job?.output != null && resolved === path.resolve(job.output));

    if (!allowed) return null;
    return existsSync(resolved) ? resolved : null;
  };

  const serveFile = (request: IncomingMessage, response: ServerResponse, filePath: string): void => {
    const info = statSync(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const range = request.headers.range;

    // Range support: the player seeks to a replica's timecode instead of
    // downloading hour-long audio up front.
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : info.size - 1;
        if (start < info.size) {
          response.writeHead(206, {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            // Файл по этому пути переписывается пересведением: закэшированный
            // кусок был бы из прежнего дубляжа.
            'Cache-Control': 'no-store',
          });
          createReadStream(filePath, { start, end }).pipe(response);
          return;
        }
      }
    }

    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  };

  const listProjects = async (): Promise<unknown[]> => {
    if (!existsSync(cacheRoot)) return [];
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'tools' || entry.name === 'models') continue;
      const dir = path.join(cacheRoot, entry.name);
      const metaPath = path.join(dir, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        const statePath = path.join(dir, 'state.json');
        const state = existsSync(statePath) ? JSON.parse(await readFile(statePath, 'utf8')) : { fingerprints: {} };
        const info = await stat(metaPath);
        projects.push({
          id: entry.name,
          input: meta.input,
          durationSeconds: meta.duration_seconds,
          hasVideo: meta.has_video,
          createdAt: meta.created_at,
          updatedAt: info.mtime.toISOString(),
          stages: Object.keys(state.fingerprints ?? {}),
        });
      } catch {
        continue;
      }
    }
    return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  };

  /**
   * Что готово к работе, чего не хватает и что именно из-за этого не выполнится.
   * Интерфейс показывает это сразу, а не прячет на отдельной вкладке (ТЗ FR-U7).
   */
  const buildReadiness = async (lang: UiLanguage = 'ru') => {
    const toolsDir = path.join(cacheRoot, 'tools');
    const modelsDir = path.join(cacheRoot, 'models');
    const items: Array<{
      id: string;
      title: string;
      state: 'ok' | 'warn' | 'blocked';
      detail: string;
      blocks: string | null;
      hint: string | null;
      canFix: boolean;
      size: string | null;
      needsToken?: boolean;
    }> = [];

    const media = await findTool('ffmpeg', toolsDir);
    const probe = await findTool('ffprobe', toolsDir);
    const mediaReady = Boolean(media && probe);
    items.push({
      id: 'ffmpeg',
      title: message('ready.ffmpeg.title', lang),
      state: mediaReady ? 'ok' : 'blocked',
      detail: message(
        mediaReady ? (media!.source === 'local' ? 'ready.ffmpeg.local' : 'ready.ffmpeg.system') : 'ready.ffmpeg.missing',
        lang,
      ),
      blocks: mediaReady ? null : message('ready.ffmpeg.blocks', lang),
      hint: mediaReady ? null : message('ready.hintFetch', lang),
      canFix: !mediaReady,
      size: message('ready.size.ffmpeg', lang),
    });

    const whisper = await findTool('whisper-cli', toolsDir);
    const asrModel = whisperModelPath(config.asr.model, modelsDir);
    const asrReady = Boolean(whisper) && existsSync(asrModel);
    items.push({
      id: 'whisper',
      title: message('ready.whisper.title', lang, { model: config.asr.model }),
      state: asrReady ? 'ok' : 'blocked',
      detail: message(
        !whisper ? 'ready.whisper.noProgram' : existsSync(asrModel) ? 'ready.ready' : 'ready.whisper.noWeights',
        lang,
      ),
      blocks: asrReady ? null : message('ready.whisper.blocks', lang),
      hint: asrReady ? null : message('ready.hintFetch', lang),
      canFix: !asrReady,
      size: message('ready.size.whisper', lang),
    });

    /*
     * Готовность синтеза спрашивается у того движка, которым будут озвучивать.
     *
     * Раньше здесь всегда проверялся piper: его программа и файл голоса. При
     * движке silero — своя модель и Python вместо программы — экран уверенно
     * сообщал «нет голоса» о голосе, которого у этого движка и не бывает, и
     * блокировал запуск там, где всё на месте.
     */
    if (config.tts.engine === 'silero') {
      const model = path.join(modelsDir, 'silero', `${SILERO_MODEL.name}.pt`);
      const python = await probePython();
      const hasPython = python.executable !== null;
      const hasModel = existsSync(model);
      // Модель скачивается сама при первом синтезе, поэтому её отсутствие —
      // не преграда, а предупреждение о предстоящей загрузке. Кнопка «докачать»
      // про неё не знает, и обещать её здесь нечестно.
      const ttsReady = hasPython && hasModel;
      items.push({
        id: 'silero',
        title: message('ready.silero.title', lang, { voice: config.tts.default_voice }),
        state: ttsReady ? 'ok' : hasPython ? 'warn' : 'blocked',
        detail: message(!hasPython ? 'ready.silero.noPython' : hasModel ? 'ready.ready' : 'ready.silero.noModel', lang),
        blocks: ttsReady ? null : message('ready.piper.blocks', lang),
        hint: ttsReady ? null : message(hasPython ? 'ready.silero.willFetch' : 'diarization.noPythonHint', lang),
        canFix: false,
        size: message('ready.size.silero', lang),
      });
    } else {
      const piper = await findTool('piper', toolsDir);
      const voice = path.join(modelsDir, 'voices', `${config.tts.default_voice}.onnx`);
      const ttsReady = Boolean(piper) && existsSync(voice);
      items.push({
        id: 'piper',
        title: message('ready.piper.title', lang, { voice: config.tts.default_voice }),
        state: ttsReady ? 'ok' : 'blocked',
        detail: message(!piper ? 'ready.piper.noProgram' : existsSync(voice) ? 'ready.ready' : 'ready.piper.noVoice', lang),
        blocks: ttsReady ? null : message('ready.piper.blocks', lang),
        hint: ttsReady ? null : message('ready.hintFetch', lang),
        canFix: !ttsReady,
        size: message('ready.size.piper', lang),
      });
    }

    const keySet = Boolean(process.env[config.kilo_gateway.api_key_env]);
    const viaGateway = config.translate.engine === 'kilo-gateway';
    const envLabel = ENV_NAME.test(config.kilo_gateway.api_key_env)
      ? config.kilo_gateway.api_key_env
      : message('ready.key.envFallback', lang);
    items.push({
      id: 'apikey',
      title: message('ready.key.title', lang, { env: envLabel }),
      state: keySet || !viaGateway ? 'ok' : 'warn',
      detail: message(keySet ? 'ready.key.set' : viaGateway ? 'ready.key.missing' : 'ready.key.notNeeded', lang),
      blocks: keySet || !viaGateway ? null : message('ready.key.blocks', lang),
      hint: keySet || !viaGateway ? null : message('ready.key.hint', lang, { env: config.kilo_gateway.api_key_env }),
      canFix: false,
      size: null,
    });

    const ytDlp = await findTool('yt-dlp', toolsDir);
    items.push({
      id: 'yt-dlp',
      title: message('ready.ytdlp.title', lang),
      state: ytDlp ? 'ok' : 'warn',
      detail: message(ytDlp ? 'ready.ready' : 'ready.ytdlp.missing', lang),
      blocks: ytDlp ? null : message('ready.ytdlp.blocks', lang),
      hint: ytDlp ? null : message('ready.hintFetch', lang),
      canFix: !ytDlp,
      size: message('ready.size.ytdlp', lang),
    });

    if (config.asr.diarization.enabled && config.asr.diarization.engine !== 'none') {
      const diarization = await probeDiarization(config, modelsDir);
      items.push({
        id: 'diarization',
        title: message('ready.diarization.title', lang),
        state: diarization.available ? 'ok' : 'warn',
        detail: diarization.available ? message('ready.diarization.ok', lang) : message(diarization.reason ?? '', lang),
        blocks: diarization.available ? null : message('ready.diarization.blocks', lang),
        hint: diarization.hint ? message(diarization.hint, lang) : null,
        canFix: Boolean(diarization.python) && (!diarization.installed || (diarization.tokenSet && !diarization.weightsReady)),
        // Признак для интерфейса: нужна кнопка ввода токена. По тексту это
        // определять нельзя — он бывает на разных языках.
        needsToken: !diarization.available && !diarization.tokenSet,
        size: message(diarization.installed ? 'ready.size.diarizationWeights' : 'ready.size.diarizationFull', lang),
      });
    }

    if (config.separation.enabled) {
      const python = await probePython();
      items.push({
        id: 'python',
        title: message('ready.python.title', lang),
        state: python.available ? 'ok' : 'warn',
        detail: python.available
          ? message('ready.python.ok', lang)
          : message('ready.python.missing', lang, { missing: python.missing.join(', ') }),
        blocks: python.available ? null : message('ready.python.blocks', lang),
        hint: python.available ? null : `${python.executable ?? 'python'} -m pip install numpy onnxruntime`,
        canFix: false,
        size: null,
      });
    }

    const blocked = items.filter((item) => item.state === 'blocked').length;
    const warnings = items.filter((item) => item.state === 'warn').length;
    return {
      items,
      ready: blocked === 0,
      blocked,
      warnings,
      summary:
        blocked > 0
          ? message('ready.summary.blocked', lang, { count: blocked })
          : warnings > 0
            ? message('ready.summary.warnings', lang, { count: warnings })
            : message('ready.summary.ok', lang),
    };
  };

  /** Куда класть субтитры: туда же, где лежит (или лежал бы) готовый дубляж. */
  const subtitleTargetDir = (input: string, meta: { output?: string | null; has_video?: boolean } | null): string => {
    // Рядом с готовым дубляжом — но только если он всё ещё там лежит:
    // разовый выбор другой папки не должен навсегда уводить туда субтитры.
    if (meta?.output && existsSync(path.dirname(meta.output))) return path.dirname(meta.output);
    return path.dirname(
      resolveOutputPath({
        input,
        extension: meta?.has_video === false ? '.m4a' : '.mp4',
        configured: config.output,
        fallbackDir: workingDir ?? undefined,
      }),
    );
  };

  /** Каталоги и медиафайлы одного уровня; содержимое файлов не читается. */
  const browseDirectory = async (target: string | null) => {
    // На Windows пустой путь означает «покажи диски».
    if (!target) {
      if (process.platform === 'win32') {
        const drives: string[] = [];
        for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
          const drive = `${String.fromCharCode(code)}:${path.sep}`;
          if (existsSync(drive)) drives.push(drive);
        }
        return {
          dir: null,
          parent: null,
          entries: drives.map((drive) => ({ name: drive, path: drive, isDir: true, isMedia: false, size: 0 })),
        };
      }
      target = path.parse(os.homedir()).root;
    }

    const dir = path.resolve(target);
    const raw = await readdir(dir, { withFileTypes: true });
    const entries = [];

    for (const item of raw) {
      if (item.name.startsWith('.') || item.name.startsWith('$')) continue;
      const full = path.join(dir, item.name);
      const isDir = item.isDirectory();
      const extension = path.extname(item.name).toLowerCase();
      const isMedia = !isDir && MEDIA_EXTENSIONS.has(extension);
      if (!isDir && !isMedia) continue;

      let size = 0;
      try {
        if (!isDir) size = (await stat(full)).size;
      } catch {
        continue; // нет доступа — просто не показываем
      }
      entries.push({ name: item.name, path: full, isDir, isMedia, size });
    }

    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ru') : a.isDir ? -1 : 1));
    const parent = path.dirname(dir);
    return { dir, parent: parent === dir ? null : parent, entries };
  };

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const route = url.pathname;
    const method = request.method ?? 'GET';

    if (route === '/api/state' && method === 'GET') {
      sendJson(response, 200, {
        version: TOOL_VERSION,
        legalNotice: LEGAL_NOTICE,
        profile: config.profile,
        cacheDir: cacheRoot,
        workingDir,
        stages: STAGE_IDS.map((id) => ({ id, title: STAGE_TITLES[id] })),
        // Языки оригинала с описанным профилем: остальные тоже работают,
        // но по латинским правилам.
        languages: Object.values(LANGUAGE_PROFILES).map((item) => ({
          code: item.code,
          name: item.name,
          nameEn: item.nameEn,
        })),
        job,
        projects: await listProjects(),
      });
      return true;
    }

    if (route === '/api/browse' && method === 'GET') {
      try {
        sendJson(response, 200, await browseDirectory(url.searchParams.get('dir')));
      } catch (error) {
        sendJson(response, 400, { error: `не удалось прочитать каталог: ${(error as Error).message}` });
      }
      return true;
    }

    if (route === '/api/workdir' && method === 'GET') {
      sendJson(response, 200, { workingDir, home: os.homedir(), videos: path.join(os.homedir(), 'Videos') });
      return true;
    }

    if (route === '/api/workdir' && method === 'PUT') {
      const body = (await readBody(request)) as { dir?: string };
      const target = body.dir ? path.resolve(body.dir) : null;
      if (target && !existsSync(target)) {
        sendJson(response, 400, { error: `папка не найдена: ${target}` });
        return true;
      }
      workingDir = target;
      await saveUiState();
      sendJson(response, 200, { workingDir });
      return true;
    }

    if (route === '/api/library' && method === 'GET') {
      // Видео рабочей папки, сопоставленные с тем, что уже обработано.
      if (!workingDir) {
        sendJson(response, 200, { workingDir: null, files: [] });
        return true;
      }
      try {
        const listing = await browseDirectory(workingDir);
        const projects = (await listProjects()) as Array<{ input: string; stages: string[]; updatedAt: string }>;
        const files = listing.entries
          .filter((entry) => entry.isMedia)
          .map((entry) => {
            const known = projects.find((project) => path.resolve(project.input) === entry.path);
            return {
              ...entry,
              stages: known?.stages ?? [],
              processedAt: known?.updatedAt ?? null,
              // Это готовый дубляж, а не исходник: дублировать его повторно
              // почти наверняка не то, чего хотят.
              dubbed: isDubbedName(entry.name),
            };
          });
        sendJson(response, 200, { workingDir, files });
      } catch (error) {
        sendJson(response, 400, { error: (error as Error).message });
      }
      return true;
    }

    if (route === '/api/readiness' && method === 'GET') {
      sendJson(response, 200, await buildReadiness(normalizeLanguage(url.searchParams.get('lang'))));
      return true;
    }

    if (route === '/api/environment' && method === 'GET') {
      const toolsDir = path.join(cacheRoot, 'tools');
      const tools = [];
      for (const name of Object.keys(TOOLS) as ToolName[]) {
        const found = await findTool(name, toolsDir);
        tools.push({
          name,
          purpose: TOOLS[name].purpose,
          required: TOOLS[name].required,
          path: found?.path ?? null,
          source: found?.source ?? null,
          installHint: TOOLS[name].installHint,
        });
      }
      const python = await probePython();
      sendJson(response, 200, {
        tools,
        python,
        keyEnv: config.kilo_gateway.api_key_env,
        keySet: Boolean(process.env[config.kilo_gateway.api_key_env]),
      });
      return true;
    }

    if (route === '/api/environment/fetch' && method === 'POST') {
      const toolsDir = path.join(cacheRoot, 'tools');
      const missing: ToolName[] = [];
      for (const name of Object.keys(TOOLS) as ToolName[]) {
        if (!TOOLS[name].fetch) continue;
        if (await findTool(name, toolsDir)) continue;
        missing.push(name);
      }

      // Веса и голос — такие же недостающие компоненты, как и программы.
      // Без них «Догрузить» нажималась впустую: программы уже на месте,
      // а работать всё равно нечем.
      const modelsDir = path.join(cacheRoot, 'models');
      const weights: Array<{ label: string; ready: boolean; fetch: () => Promise<unknown> }> = [
        {
          label: `модель распознавания «${config.asr.model}»`,
          ready: existsSync(whisperModelPath(config.asr.model, modelsDir)),
          fetch: () => ensureWhisperModel(config.asr.model, modelsDir),
        },
        {
          label: 'silero-vad (ONNX)',
          ready: !config.asr.vad.enabled || existsSync(path.join(modelsDir, 'silero-vad.onnx')),
          fetch: () => ensureSileroVad(modelsDir),
        },
        ...[...new Set([config.tts.default_voice, ...Object.values(config.tts.voice_map)])].map((voice) => ({
          label: `голос ${voice}`,
          ready: existsSync(path.join(modelsDir, 'voices', `${voice}.onnx`)),
          fetch: () => ensureVoice(voice, modelsDir),
        })),
      ].filter((item) => !item.ready);

      // Диаризация: pip-установка и веса с Hugging Face. Без Python или без
      // токена чинить нечего — пункт остаётся в «Окружении» с подсказкой.
      if (config.asr.diarization.enabled && config.asr.diarization.engine !== 'none') {
        const diarization = await probeDiarization(config, modelsDir);
        const fixable = Boolean(diarization.python) && (!diarization.installed || (diarization.tokenSet && !diarization.weightsReady));
        if (fixable) {
          weights.push({
            label: 'диаризация (pyannote + PyTorch)',
            ready: false,
            fetch: () => installDiarization(config, modelsDir),
          });
        }
      }

      if (missing.length === 0 && weights.length === 0) {
        sendJson(response, 200, { started: false, note: 'всё необходимое уже загружено' });
        return true;
      }

      // Отвечаем сразу: загрузка идёт минутами, а её ход виден через поток
      // событий — иначе интерфейс выглядит зависшим.
      sendJson(response, 202, { started: true, tools: missing, weights: weights.map((item) => item.label) });

      void (async () => {

        // Компоненты приходят архивами, и один архив может давать несколько
        // программ (ffmpeg и ffprobe). Полоса хода — на архив, а не на программу:
        // иначе ffprobe висит с «подготовка…», пока качается ffmpeg, и выглядит
        // застрявшим.
        const groups = new Map<string, ToolName[]>();
        for (const name of missing) {
          const key = TOOLS[name].fetchKey ?? name;
          groups.set(key, [...(groups.get(key) ?? []), name]);
        }

        // Архивы загружаются одновременно: по очереди это заметно дольше,
        // а каждый файл внутри ещё делится между соединениями.
        await Promise.all(
          [...groups.entries()].map(async ([key, names]) => {
            const id = `provision:${key}`;
            // Метка совпадает с меткой загрузки файла, чтобы интерфейс показал
            // одну полосу на архив: сначала загрузку, потом распаковку.
            const label = names[0]!;
            progress.emit({ id, kind: 'provision', label, status: 'running', percent: null, detail: 'распаковка' });
            try {
              for (const name of names) await provisionTool(name, toolsDir);
              progress.emit({ id, kind: 'provision', label, status: 'done', percent: 100 });
            } catch (error) {
              progress.emit({
                id,
                kind: 'provision',
                label,
                status: 'error',
                percent: null,
                detail: (error as Error).message,
              });
            }
          }),
        );

        // Веса качаются параллельно с программами; о ходе сообщает сам загрузчик.
        await Promise.all(
          weights.map(async (item) => {
            try {
              await item.fetch();
            } catch (error) {
              progress.emit({
                id: `weights:${item.label}`,
                kind: 'provision',
                label: item.label,
                status: 'error',
                percent: null,
                detail: (error as Error).message,
              });
            }
          }),
        );

        broadcast('readiness', await buildReadiness());
      })();
      return true;
    }

    if (route === '/api/config' && method === 'GET') {
      const target = options.configPath ?? path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);
      const text = existsSync(target) ? await readFile(target, 'utf8') : await readFile(exampleConfigPath(), 'utf8');
      sendJson(response, 200, { path: target, exists: existsSync(target), text, parsed: config });
      return true;
    }

    if (route === '/api/config' && method === 'PUT') {
      const body = (await readBody(request)) as { text?: string };
      try {
        const parsed = parseConfig(YAML.parse(body.text ?? ''), 'интерфейс');
        const target = options.configPath ?? path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);
        await writeFile(target, body.text ?? '', 'utf8');
        config = parsed;
        sendJson(response, 200, { ok: true, parsed });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: (error as Error).message });
      }
      return true;
    }

    if (route === '/api/config/values' && method === 'PUT') {
      const body = (await readBody(request)) as { values?: Record<string, unknown> };
      if (!body.values || typeof body.values !== 'object') {
        sendJson(response, 400, { error: 'нужно поле values' });
        return true;
      }
      try {
        const parsed = await applyConfigValues(body.values);
        sendJson(response, 200, { ok: true, parsed, readiness: await buildReadiness(normalizeLanguage(url.searchParams.get('lang'))) });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: (error as Error).message });
      }
      return true;
    }

    if (route === '/api/key' && method === 'GET') {
      sendJson(response, 200, keyStatus());
      return true;
    }

    if (route === '/api/key' && method === 'PUT') {
      const body = (await readBody(request)) as { key?: string | null };
      const value = typeof body.key === 'string' ? body.key.trim() : null;
      await saveSecret(config.kilo_gateway.api_key_env, value || null);
      sendJson(response, 200, { ...keyStatus(), readiness: await buildReadiness(normalizeLanguage(url.searchParams.get('lang'))) });
      return true;
    }

    if (route === '/api/hf-token' && method === 'GET') {
      sendJson(response, 200, hfTokenStatus());
      return true;
    }

    if (route === '/api/hf-token' && method === 'PUT') {
      const body = (await readBody(request)) as { token?: string | null };
      const value = typeof body.token === 'string' ? body.token.trim() : null;
      await saveSecret(config.asr.diarization.hf_token_env, value || null);
      resetDiarizationProbe();
      sendJson(response, 200, { ...hfTokenStatus(), readiness: await buildReadiness(normalizeLanguage(url.searchParams.get('lang'))) });
      return true;
    }

    if (route === '/api/models/check' && method === 'POST') {
      // Проверка модели из настроек: три реплики выбранной моделью.
      const body = (await readBody(request)) as { model?: string };
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!model) {
        sendJson(response, 400, { error: 'нужно поле model' });
        return true;
      }
      sendJson(response, 200, await checkModel(config, model));
      return true;
    }

    if (route === '/api/key/check' && method === 'POST') {
      // Проверка ключа коротким запросом к шлюзу: сразу видно, рабочий ли он.
      const client = await KiloGatewayClient.create(config);
      if (!client) {
        sendJson(response, 200, { ok: false, reason: 'ключ не задан' });
        return true;
      }
      const ok = await client.available();
      sendJson(response, 200, { ok, reason: ok ? null : 'шлюз не принял ключ или недоступен' });
      return true;
    }

    if (route === '/api/voices/preview' && method === 'POST') {
      const body = (await readBody(request)) as { voice?: string; text?: string };
      const voice = body.voice ?? config.tts.default_voice;
      try {
        const workspace = await Workspace.open('voice-preview', config);
        const provider = createTtsProvider(workspace, config);
        const text = body.text?.trim() || 'Так будет звучать дубляж этим голосом.';
        // Имя пробы включает и текст: иначе проба чужой реплики звучала бы
        // прежней — файл для этого голоса уже лежит.
        const target = workspace.file(`preview-${voice}-${sha256(text).slice(0, 12)}.wav`);
        if (!existsSync(target)) {
          await provider.synthesize({ id: -1, voice, text, outputPath: target });
        }
        sendJson(response, 200, { path: target });
      } catch (error) {
        sendJson(response, 500, { error: (error as Error).message });
      }
      return true;
    }

    if (route === '/api/cache/clear' && method === 'POST') {
      const body = (await readBody(request)) as { input?: string };
      if (job?.status === 'running') {
        sendJson(response, 409, { error: 'сначала дождитесь окончания задачи' });
        return true;
      }
      if (body.input) {
        const workspace = await Workspace.open(body.input, config);
        await workspace.clear();
        sendJson(response, 200, { ok: true, removed: 1 });
      } else {
        const removed = await Workspace.clearAll(config);
        sendJson(response, 200, { ok: true, removed });
      }
      return true;
    }

    if (route === '/api/models' && method === 'GET') {
      try {
        const catalog = await loadCatalog(config, url.searchParams.get('refresh') === '1');
        sendJson(response, 200, {
          models: filterCatalog(catalog, {
            search: url.searchParams.get('search') ?? undefined,
            freeOnly: url.searchParams.get('free') === '1',
            limit: Number(url.searchParams.get('limit') ?? 60),
          }),
          total: catalog.length,
        });
      } catch (error) {
        sendJson(response, 502, { error: (error as Error).message });
      }
      return true;
    }

    if (route === '/api/devices' && method === 'GET') {
      // Опрос адаптеров идёт через PowerShell и занимает около секунды,
      // а железо за время работы программы не меняется.
      deviceCache ??= deviceOptions(await detectHardware());
      sendJson(response, 200, deviceCache);
      return true;
    }

    if (route === '/api/voices' && method === 'GET') {
      sendJson(response, 200, {
        voices: voicesForEngine(config.tts.engine),
        defaultVoice: config.tts.default_voice,
        voiceMap: config.tts.voice_map,
      });
      return true;
    }

    if (route === '/api/segments' && method === 'GET') {
      const input = url.searchParams.get('input');
      if (!input) {
        sendJson(response, 400, { error: 'не указан input' });
        return true;
      }
      const workspace = await Workspace.open(input, config);
      const segments = (await workspace.readSegments()) ?? [];
      const meta = await workspace.readMeta();
      // Итог лежит там же, куда его кладёт S7; если он есть — режим просмотра доступен.
      let output: string | null = null;
      if (meta) {
        // Где итог лежит на самом деле, знает meta (S7 туда это пишет);
        // для старых рабочих каталогов остаётся расчёт по умолчанию.
        const extension = meta.has_video ? '.mp4' : '.m4a';
        const candidates = [
          meta.output,
          resolveOutputPath({ input: meta.input, extension, configured: config.output, fallbackDir: workingDir ?? undefined }),
          // Прогоны до исправления пути складывали итог в рабочий каталог программы.
          path.resolve(defaultOutputName(meta.input, extension)),
        ].filter((candidate): candidate is string => Boolean(candidate));
        const found = candidates.find((candidate) => existsSync(candidate));
        if (found) {
          output = found;
          knownOutputs.add(found);
        }
      }
      sendJson(response, 200, {
        segments,
        meta,
        dir: workspace.dir,
        // Куда ляжет итог, если ничего не выбирать: показывается в «Дополнительно».
        defaultOutputDir: meta
          ? path.dirname(
              resolveOutputPath({
                input: meta.input,
                extension: meta.has_video ? '.mp4' : '.m4a',
                configured: config.output,
                fallbackDir: workingDir ?? undefined,
              }),
            )
          : null,
        originalAudio: existsSync(workspace.file('original.wav')) ? workspace.file('original.wav') : null,
        // Мерка длины — та же, которой меряет конвейер: место с занимаемой
        // паузой, замеренный темп с надбавкой и допуск из настроек.
        fit: await fitRuler(workspace, config, segments),
        output,
        overrides: await workspace.readOverrides(),
        voices: voicesForEngine(config.tts.engine),
        defaultVoice: config.tts.default_voice,
        // Карта голосов с учётом пола, определённого на S2; правки видео поверх неё — в overrides.
        voiceMap: applyOverrides(config, EMPTY_OVERRIDES, await workspace.readSpeakers()).tts.voice_map,
        speakers: await workspace.readSpeakers(),
        mix: {
          background_gain_db: config.mix.background_gain_db,
          voice_gain_db: config.mix.voice_gain_db,
          duck_db: config.mix.duck_db,
        },
      });
      return true;
    }

    if (route === '/api/project/review' && method === 'POST') {
      // Правки из режима просмотра: голоса спикеров, спикеры и текст реплик,
      // громкости. Реплики, которым нужен новый синтез, лишаются старого —
      // и запуск со стадии S5 пересинтезирует только их.
      const body = (await readBody(request)) as { input?: string; segments?: Segment[]; overrides?: unknown };
      if (!body.input || !Array.isArray(body.segments)) {
        sendJson(response, 400, { error: 'нужны поля input и segments' });
        return true;
      }
      if (job?.status === 'running') {
        sendJson(response, 409, { error: 'сначала дождитесь окончания задачи' });
        return true;
      }
      const workspace = await Workspace.open(body.input, config);
      const previous = (await workspace.readSegments()) ?? [];
      const previousOverrides = await workspace.readOverrides();
      const nextOverrides = normalizeOverrides(body.overrides);
      // Отпечаток движка — часть подписи клипа: по ней и видно, надо ли его
      // переделывать.
      const plan = planReview(
        config,
        previous,
        body.segments,
        previousOverrides,
        nextOverrides,
        await workspace.readSpeakers(),
        createTtsProvider(workspace, config).fingerprint,
      );
      await workspace.writeSegments(plan.segments);
      await workspace.writeOverrides(nextOverrides);
      sendJson(response, 200, { ok: true, affected: plan.affected, fromStage: plan.fromStage });
      return true;
    }

    if (route === '/api/segments' && method === 'PUT') {
      const body = (await readBody(request)) as { input?: string; segments?: Segment[] };
      if (!body.input || !Array.isArray(body.segments)) {
        sendJson(response, 400, { error: 'нужны поля input и segments' });
        return true;
      }
      const workspace = await Workspace.open(body.input, config);
      await workspace.writeSegments(body.segments);
      sendJson(response, 200, { ok: true, count: body.segments.length });
      return true;
    }

    if (route === '/api/subtitles' && method === 'GET') {
      const input = url.searchParams.get('input');
      if (!input) {
        sendJson(response, 400, { error: 'не указан input' });
        return true;
      }
      const workspace = await Workspace.open(input, config);
      const segments = (await workspace.readSegments()) ?? [];
      const meta = await workspace.readMeta();
      const options = subtitleOptionsFrom(config);
      const targetDir = subtitleTargetDir(meta?.input ?? input, meta);

      // Два файла: оригинал на языке записи и перевод на русском.
      const sourceCode = config.asr.language;
      const tracks = [
        { kind: 'source' as const, code: sourceCode, text: (segment: Segment) => segment.text_en },
        { kind: 'target' as const, code: 'ru', text: (segment: Segment) => segment.text_ru },
      ];

      const languages = await Promise.all(
        tracks.map(async (track) => {
          // Правленые титры важнее пересчёта из реплик: их правил человек.
          const saved = await workspace.readCues(track.kind);
          const trackOptions = optionsForLanguage(options, track.code);
          const cues =
            saved ??
            planCues(
              segments
                .map((segment) => ({
                  id: segment.id,
                  start: segment.start,
                  end: segment.end,
                  text: track.text(segment) ?? '',
                }))
                .filter((item) => item.text.trim().length > 0),
              trackOptions,
            );
          const file = path.join(targetDir, subtitleFileName(meta?.input ?? input, track.code));
          if (existsSync(file)) knownOutputs.add(file);
          return {
            kind: track.kind,
            lang: track.code,
            name: languageProfile(track.code).name,
            edited: saved !== null,
            file,
            exists: existsSync(file),
            cues: cues.map((cue, index) => ({
              ...cue,
              index: index + 1,
              problems: cueProblems(cue, cues[index + 1], trackOptions),
            })),
          };
        }),
      );

      sendJson(response, 200, {
        languages,
        options,
        targetDir,
        hasSegments: segments.length > 0,
        translated: segments.some((segment) => (segment.text_ru ?? '').trim().length > 0),
        source: meta && existsSync(meta.input) ? meta.input : null,
      });
      return true;
    }

    if (route === '/api/subtitles' && method === 'PUT') {
      // Сохранение правок: титры кладутся в рабочий каталог и сразу пишутся в SRT.
      const body = (await readBody(request)) as { input?: string; kind?: 'source' | 'target'; cues?: Cue[]; dir?: string };
      if (!body.input || (body.kind !== 'source' && body.kind !== 'target') || !Array.isArray(body.cues)) {
        sendJson(response, 400, { error: 'нужны поля input, kind (source|target) и cues' });
        return true;
      }
      const workspace = await Workspace.open(body.input, config);
      const meta = await workspace.readMeta();
      const cues = body.cues
        .map((cue, index) => ({
          index: index + 1,
          start: Number(cue.start),
          end: Number(cue.end),
          lines: (cue.lines ?? []).map((line) => String(line).trim()).filter((line) => line.length > 0),
          segmentId: Number(cue.segmentId ?? -1),
        }))
        .filter((cue) => cue.lines.length > 0 && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
        .sort((a, b) => a.start - b.start)
        .map((cue, index) => ({ ...cue, index: index + 1 }));

      await workspace.writeCues(body.kind, cues);
      const targetDir = body.dir ? path.resolve(body.dir) : subtitleTargetDir(meta?.input ?? body.input, meta);
      await mkdir(targetDir, { recursive: true });
      const code = body.kind === 'target' ? 'ru' : config.asr.language;
      const file = path.join(targetDir, subtitleFileName(meta?.input ?? body.input, code));
      await writeFile(file, `\uFEFF${formatSrt(cues)}`, 'utf8');
      knownOutputs.add(file);
      sendJson(response, 200, { ok: true, file, count: cues.length });
      return true;
    }

    if (route === '/api/subtitles/rebuild' && method === 'POST') {
      // Вернуться к титрам, рассчитанным из реплик: правки удаляются.
      const body = (await readBody(request)) as { input?: string; kind?: 'source' | 'target' };
      if (!body.input || (body.kind !== 'source' && body.kind !== 'target')) {
        sendJson(response, 400, { error: 'нужны поля input и kind (source|target)' });
        return true;
      }
      const workspace = await Workspace.open(body.input, config);
      const target = workspace.cuesPath(body.kind);
      if (existsSync(target)) await rm(target, { force: true });
      sendJson(response, 200, { ok: true });
      return true;
    }

    if (route === '/api/media' && method === 'GET') {
      const raw = url.searchParams.get('path');
      const resolved = raw ? safeMediaPath(raw) : null;
      if (!resolved) {
        sendJson(response, 403, { error: 'путь вне рабочего каталога' });
        return true;
      }
      serveFile(request, response, resolved);
      return true;
    }

    if (route === '/api/jobs' && method === 'POST') {
      if (job?.status === 'running') {
        sendJson(response, 409, { error: 'уже выполняется другая задача' });
        return true;
      }
      const body = (await readBody(request)) as {
        input?: string;
        fromStage?: StageId;
        toStage?: StageId;
        model?: string;
        out?: string;
        /** Папка для итога; имя файла строится автоматически. */
        outDir?: string;
        /** `subtitles` — только распознавание, перевод и запись двух SRT. */
        mode?: 'dub' | 'subtitles';
      };
      if (!body.input) {
        sendJson(response, 400, { error: 'не указан input' });
        return true;
      }
      // Субтитрам нужны стадии до перевода включительно — дальше идёт озвучка.
      const subtitlesOnly = body.mode === 'subtitles';
      if (subtitlesOnly) body.toStage = 's3';

      const runConfig: DubConfig = body.model
        ? { ...config, translate: { ...config.translate, model: body.model } }
        : config;

      const planned = STAGE_IDS.filter((id) => {
        const from = body.fromStage ? STAGE_IDS.indexOf(body.fromStage) : 0;
        const to = body.toStage ? STAGE_IDS.indexOf(body.toStage) : STAGE_IDS.length - 1;
        const index = STAGE_IDS.indexOf(id);
        if (index < from || index > to) return false;
        if (id === 's4' && !runConfig.separation.enabled) return false;
        if (id === 's6' && !runConfig.alignment.enabled) return false;
        return true;
      });

      job = {
        id: randomBytes(8).toString('hex'),
        input: body.input,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        mode: subtitlesOnly ? 'subtitles' : 'dub',
        stages: planned.map((id) => ({ id, title: STAGE_TITLES[id], state: 'pending' as const })),
        warnings: [],
        output: null,
        error: null,
      };
      cancelRequested = false;
      cancellation.begin();
      broadcast('job', job);
      sendJson(response, 202, job);

      // Runs in the background: the HTTP response is already sent, and progress
      // reaches the page through the event stream.
      void (async () => {
        const current = job!;
        try {
          const report = await runPipeline({
            input: body.input!,
            config: runConfig,
            ...(body.out ? { out: body.out } : {}),
            ...(body.outDir ? { outDir: body.outDir } : {}),
            ...(subtitlesOnly ? { subtitles: true } : {}),
            ...(body.fromStage ? { fromStage: body.fromStage } : {}),
            ...(body.toStage ? { toStage: body.toStage } : {}),
          });
          finishStages(current.stages, new Date().toISOString(), 'done');
          for (const outcome of report.outcomes) {
            const stage = current.stages.find((item) => item.id === outcome.stage);
            if (stage) {
              // Признак «из кэша» — полем, а не подписью: интерфейс переводит
              // её сам, и сравнивать перевод со строкой ему незачем.
              stage.cached = outcome.cached;
              stage.provider = outcome.cached ? undefined : outcome.provider;
            }
          }
          current.warnings = report.warnings;
          current.output = report.output;
          current.subtitles = report.subtitles;
          current.status = 'done';
        } catch (error) {
          finishStages(current.stages, new Date().toISOString(), 'pending');
          if (isCancelled(error) || cancelRequested) {
            // Остановка — не ошибка: готовые стадии остались в кэше,
            // незавершённая пересчитается при следующем запуске.
            current.status = 'cancelled';
            current.error = null;
          } else {
            current.status = 'error';
            current.error =
              error instanceof DubPipeError
                ? [error.message, ...error.hints.map((hint) => `→ ${hint}`)].join('\n')
                : (error as Error).message;
          }
        } finally {
          cancellation.end();
          current.finishedAt = new Date().toISOString();
          broadcast('job', current);
        }
      })();
      return true;
    }

    if (route === '/api/jobs/cancel' && method === 'POST') {
      if (!job || job.status !== 'running') {
        sendJson(response, 200, { ok: false, note: 'нечего останавливать' });
        return true;
      }
      cancelRequested = true;
      // Сигнал убивает дочерние процессы и обрывает запросы к моделям;
      // задача завершится статусом «остановлено» через событие job.
      cancellation.abort();
      sendJson(response, 200, { ok: true, note: 'останавливаю' });
      return true;
    }

    if (route === '/api/compare' && method === 'POST') {
      const body = (await readBody(request)) as { input?: string; models?: string[]; limit?: number };
      if (!body.input || !Array.isArray(body.models) || body.models.length === 0) {
        sendJson(response, 400, { error: 'нужны поля input и models' });
        return true;
      }
      try {
        const workspace = await Workspace.open(body.input, config);
        const stored = (await workspace.readSegments()) ?? [];
        const segments = body.limit && body.limit > 0 ? stored.slice(0, body.limit) : stored;
        const report = await compareModels(config, segments, body.models, body.input);
        await workspace.writeJson(workspace.file('compare.json'), report);
        sendJson(response, 200, report);
      } catch (error) {
        sendJson(response, 500, { error: (error as Error).message });
      }
      return true;
    }

    if (route === '/api/events' && method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      response.write(
        `event: hello\ndata: ${JSON.stringify({ job, history, progress: progress.active() })}\n\n`,
      );
      clients.add(response);
      const keepAlive = setInterval(() => response.write(': ping\n\n'), 20_000);
      request.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(response);
      });
      return true;
    }

    return false;
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');

        // Token gate: it protects data and actions, not the page shell.
        // The browser loads style.css and app.js without any token of its own,
        // so gating static assets leaves the page unstyled and lifeless; those
        // files carry nothing worth hiding and the socket is loopback-only.
        if (url.pathname.startsWith('/api/')) {
          const provided = url.searchParams.get('token') ?? request.headers['x-dubpipe-token'];
          if (provided !== token) {
            sendJson(response, 401, { error: 'неверный токен доступа' });
            return;
          }
        }

        if (url.pathname.startsWith('/api/')) {
          const handled = await handleApi(request, response, url);
          if (!handled) sendJson(response, 404, { error: `нет обработчика для ${url.pathname}` });
          return;
        }

        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const target = path.join(assets, name);
        if (!target.startsWith(assets) || !existsSync(target) || !statSync(target).isFile()) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('не найдено');
          return;
        }
        serveFile(request, response, target);
      } catch (error) {
        sendJson(response, 500, { error: (error as Error).message });
      }
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    // Loopback only: the interface is never reachable from the network.
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        server.close(() => resolve());
      }),
  };
}
