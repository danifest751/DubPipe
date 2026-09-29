import { existsSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DubConfig } from '../../config/schema.js';
import { cancellation, isCancelled } from '../../core/cancel.js';
import { judgeClip, type ClipVerdict } from '../../core/clip-check.js';
import { languageProfile } from '../../core/languages.js';
import { log } from '../../core/logger.js';
import type { ProjectOverrides } from '../../core/overrides.js';
import { warn, type Segment, type StageWarning } from '../../core/types.js';
import {
  EDGE_FRAME_SECONDS,
  EDGE_SEARCH_SECONDS,
  pickReference,
  referenceCandidates,
  referenceEdges,
  type DiarizationTurnLike,
  type ReferenceCut,
  type ReferenceCandidate,
} from '../../core/voice-refs.js';
import type { Workspace } from '../../core/workspace.js';
import { run } from '../../util/exec.js';
import { sha256 } from '../../util/hash.js';
import { requireTool } from '../../util/tools.js';
import { readClip, wavDuration } from '../../util/wav.js';
import {
  CloneError,
  cloneSpeech,
  ensureCloneRef,
  onServer,
  serverTitle,
  serverUnavailable,
  workerHealth,
} from '../remote/server.js';

/**
 * Голоса актёров: реплики, озвученные голосом того, кто говорит в оригинале.
 *
 * Шаг идёт последним в подгонке (S6). К этому моменту базовый движок уже
 * озвучил реплики, а подгонка решила, сколько времени у каждой, и сократила
 * то, что не влезало. X-Voice на сервере озвучивает каждую реплику ровно в это
 * время — не растягивая готовый звук, а проговаривая текст своим темпом.
 * Реплика, которую озвучить не вышло, остаётся голосом базового движка: пустого
 * места в фильме это не оставит никогда.
 */

/** Версия модели в подписи клипа: сменится модель — клипы переделаются. */
const MODEL_TAG = 'xvoice-stage1-817bcdd';

/**
 * Годна ли длина клипа голоса актёра.
 *
 * Подгонка уже решила, сколько времени у реплики, и клип длиннее этого налезает
 * на следующую реплику. Так и вышло на длинных репликах: X-Voice резал текст на
 * куски и давал каждому полную длину — клип на 14 с приходил 29-секундным. Мост
 * это больше не делает, но проверка остаётся: чужая ошибка не должна снова
 * наложить голоса друг на друга. Короче заказа — не беда: будет пауза.
 */
export function fitsLength(got: number, wanted: number): boolean {
  return got <= wanted + Math.max(0.3, wanted * 0.1);
}

/** Сколько реплик держать в пути к серверу: пока одна считается, вторая едет. */
const IN_FLIGHT = 2;

/**
 * Сколько раз озвучивать реплику, если проверка находит брак: первая попытка
 * и две повторных. Дальше не лучше — остаётся лучшая из попыток.
 */
const CHECK_ATTEMPTS = 3;

/** «0:34», «1:02:05» — так реплику найдут в плеере. */
function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export interface CloneSummary {
  provider: string;
  voiced: number;
  reused: number;
  failed: number;
  /** Повторных озвучек после проверки. */
  retried: number;
  /** Реплик, в которых и лучшая попытка не прошла проверку. */
  flagged: number;
  speakers: Record<string, ReferenceCandidate | null>;
}

/** Реплики говорящих из разбора по голосам; без него каждая реплика «одна в сцене». */
async function readTurns(workspace: Workspace): Promise<DiarizationTurnLike[]> {
  const parsed = await workspace.readJson<{ turns?: DiarizationTurnLike[] }>(workspace.file('diarization.json'));
  return parsed?.turns ?? [];
}

/** Звук, с которого снимаются образцы: отделённый голос, без него — оригинал. */
function referenceSource(workspace: Workspace): string | null {
  const vocals = workspace.file('vocals.wav');
  const original = workspace.file('original.wav');
  return existsSync(vocals) ? vocals : existsSync(original) ? original : null;
}

/** Версия правил `referenceEdges`. */
const EDGE_RULES = 2;

/** Найденные края образцов; годны, пока не сменился звук, с которого их мерили. */
interface EdgeCache {
  source: string;
  stamp: string;
  edges: Record<string, ReferenceCut | null>;
}

/**
 * Меряет громкость вокруг реплики и ищет по ней края образца (см.
 * `referenceEdges`). Результат запоминается: панель голосов спрашивает образцы
 * при каждом открытии, а звук за это время не меняется.
 */
async function measureEdges(
  workspace: Workspace,
  ffmpeg: string,
  source: string,
  segments: Segment[],
  candidate: ReferenceCandidate,
  cache: EdgeCache,
): Promise<ReferenceCut | null> {
  const key = `${candidate.start.toFixed(3)}-${candidate.end.toFixed(3)}`;
  if (key in cache.edges) return cache.edges[key]!;

  const others = segments.filter((segment) => segment.id !== candidate.id);
  const before = others.filter((segment) => segment.start < candidate.start).map((segment) => segment.end);
  const after = others.filter((segment) => segment.start > candidate.start).map((segment) => segment.start);
  const windowStart = Math.max(0, candidate.start - EDGE_SEARCH_SECONDS);
  const windowEnd = candidate.end + EDGE_SEARCH_SECONDS;
  const probe = path.join(await workspace.subdir('refs'), '.edges.wav');
  let edges: ReferenceCut | null = null;
  try {
    await run(
      ffmpeg,
      ['-y', '-v', 'error', '-ss', windowStart.toFixed(3), '-t', (windowEnd - windowStart).toFixed(3), '-i', source, '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', probe],
      { timeoutMs: 60_000 },
    );
    const { samples, sampleRate } = await readClip(probe);
    const size = Math.round(EDGE_FRAME_SECONDS * sampleRate);
    const levels: number[] = [];
    for (let offset = 0; offset + size <= samples.length; offset += size) {
      let energy = 0;
      for (let i = offset; i < offset + size; i++) energy += samples[i]! * samples[i]!;
      levels.push(10 * Math.log10(energy / size + 1e-12));
    }
    edges = referenceEdges(levels, windowStart, candidate, {
      previousEnd: before.length > 0 ? Math.max(...before) : null,
      nextStart: after.length > 0 ? Math.min(...after) : null,
    });
  } catch (error) {
    log.debug(`края образца ${candidate.id}: не измерить (${(error as Error).message}) — режем по распознаванию`);
    return null;
  } finally {
    await rm(probe, { force: true });
  }
  cache.edges[key] = edges;
  return edges;
}

/**
 * Образцы по персонажам: выбранные человеком, иначе лучшие по правилам.
 *
 * Из лучших берётся первая реплика с паузой на обоих краях, нет такой — с
 * паузой хотя бы в конце: образец, оборванный на полуслове, модель
 * договаривает в начале каждой озвученной реплики. Нет и такой — лучшая как есть. Выбранную человеком не заменяем, только
 * подрезаем по паузам, если они есть.
 */
export async function chooseReferences(
  workspace: Workspace,
  config: DubConfig,
  segments: Segment[],
  overrides: ProjectOverrides,
): Promise<Record<string, ReferenceCandidate | null>> {
  const turns = await readTurns(workspace);
  const options = { charsPerSecond: languageProfile(config.asr.language).subtitleCps };
  const source = referenceSource(workspace);
  const ffmpeg = source ? await requireTool('ffmpeg', workspace.toolsDir).catch(() => null) : null;

  const cacheFile = workspace.file(path.join('refs', 'edges.json'));
  let cache: EdgeCache = { source: '', stamp: '', edges: {} };
  if (source) {
    const info = await stat(source);
    // Правила поиска краёв — в подписи: поменялись они, мерим заново.
    const stamp = `${EDGE_RULES}-${info.size}-${Math.round(info.mtimeMs)}`;
    const saved = await workspace.readJson<EdgeCache>(cacheFile);
    cache = saved && saved.source === path.basename(source) && saved.stamp === stamp ? saved : { source: path.basename(source), stamp, edges: {} };
  }
  const measured = Object.keys(cache.edges).length;

  const result: Record<string, ReferenceCandidate | null> = {};
  for (const speaker of [...new Set(segments.map((segment) => segment.speaker))].sort()) {
    const chosen = overrides.refs?.[speaker];
    const fallback = pickReference(segments, turns, speaker, options, chosen);
    if (!fallback || !ffmpeg || !source) {
      result[speaker] = fallback;
      continue;
    }
    const cutOf = async (candidate: ReferenceCandidate): Promise<ReferenceCandidate | null> => {
      const cut = await measureEdges(workspace, ffmpeg, source, segments, candidate, cache);
      return cut ? { ...candidate, cut } : null;
    };
    if (typeof chosen === 'number' && fallback.id === chosen) {
      result[speaker] = (await cutOf(fallback)) ?? fallback;
      continue;
    }
    // Лучше всего — с паузой на обоих краях; иначе хотя бы в конце.
    let picked: ReferenceCandidate | null = null;
    for (const candidate of referenceCandidates(segments, turns, speaker, options)) {
      const cut = await cutOf(candidate);
      if (cut && !picked) picked = cut;
      if (cut?.cut?.cleanStart) {
        picked = cut;
        break;
      }
    }
    if (!picked) log.debug(`${speaker}: ни у одной реплики нет паузы на краях — образец по распознаванию`);
    result[speaker] = picked ?? fallback;
  }
  if (source && Object.keys(cache.edges).length !== measured) {
    await workspace.subdir('refs');
    await writeFile(cacheFile, JSON.stringify(cache), 'utf8');
  }
  return result;
}

/** Путь к образцу персонажа в рабочем каталоге: его же слушают в интерфейсе. */
export function referencePath(workspace: Workspace, speaker: string): string {
  return workspace.file(path.join('refs', `${speaker.replace(/[^A-Za-z0-9_-]/g, '_')}.wav`));
}

/**
 * Вырезает образец с отделённой дорожки голоса; без неё — из оригинала, где
 * под голосом музыка, и об этом говорит предупреждение.
 */
async function extractReference(
  workspace: Workspace,
  speaker: string,
  reference: ReferenceCandidate,
  ffmpeg: string,
): Promise<string> {
  const source = referenceSource(workspace) ?? workspace.file('original.wav');
  await workspace.subdir('refs');
  const target = referencePath(workspace, speaker);
  const start = reference.cut?.start ?? reference.start;
  const seconds = reference.cut ? reference.cut.end - reference.cut.start : reference.seconds + 0.05;
  await run(
    ffmpeg,
    ['-y', '-v', 'error', '-ss', start.toFixed(3), '-t', seconds.toFixed(3), '-i', source, '-ac', '1', '-ar', '24000', '-acodec', 'pcm_s16le', target],
    { timeoutMs: 60_000 },
  );
  return target;
}

/**
 * Озвучивает реплики голосами актёров поверх клипов подгонки.
 *
 * Меняет `aligned_file` и `aligned_duration` у озвученных реплик; клипы
 * базового движка остаются в `aligned/` — на них откатится следующий прогон с
 * выключенными голосами актёров. `null` — шаг выключен.
 */
export async function voiceWithActors(
  workspace: Workspace,
  config: DubConfig,
  segments: Segment[],
  overrides: ProjectOverrides,
  warnings: StageWarning[],
): Promise<CloneSummary | null> {
  if (!config.tts.clone.enabled) return null;

  if (!onServer(config, 'clone')) {
    warnings.push(
      warn('warn.clone.noServer', 'Голоса актёров включены, но сервер с видеокартой не задан — озвучено базовым голосом'),
    );
    return null;
  }
  const reason = await serverUnavailable(config, 'clone');
  if (reason !== null) {
    warnings.push(warn('warn.clone.unavailable', `Голоса актёров недоступны (${reason}) — озвучено базовым голосом`, { reason }));
    return null;
  }
  if (!existsSync(workspace.file('vocals.wav'))) {
    warnings.push(
      warn(
        'warn.clone.noVocals',
        'Образцы голосов сняты с оригинала, а не с отделённой дорожки голоса: включите отделение голоса — под образцом не будет музыки',
      ),
    );
  }

  const ffmpeg = await requireTool('ffmpeg', workspace.toolsDir);
  const references = await chooseReferences(workspace, config, segments, overrides);
  const refKeys = new Map<string, { key: string; text: string }>();
  for (const [speaker, reference] of Object.entries(references)) {
    if (reference === null) continue;
    const file = await extractReference(workspace, speaker, reference, ffmpeg);
    refKeys.set(speaker, { key: await ensureCloneRef(config, file), text: reference.text });
  }
  const without = Object.entries(references)
    .filter(([speaker, reference]) => reference === null && overrides.refs?.[speaker] !== 'off')
    .map(([speaker]) => speaker);
  if (without.length > 0) {
    warnings.push(
      warn(
        'warn.clone.noReference',
        `Для ${without.join(', ')} нет реплики, годной в образец голоса, — они говорят базовым голосом`,
        { speakers: without.join(', ') },
      ),
    );
  }

  const cloneDir = await workspace.subdir('clone');
  const pending = segments.filter(
    (segment) => segment.aligned_file && (segment.aligned_duration ?? 0) > 0.2 && segment.text_ru?.trim() && refKeys.has(segment.speaker),
  );
  const health = await workerHealth(config);
  const provider = `X-Voice (${serverTitle(config, health)})`;
  log.step(`голоса актёров: ${pending.length} реплик, персонажей ${refKeys.size}, ${provider}`);
  const check = config.tts.clone.check && health?.capabilities.clone_check === true;
  if (config.tts.clone.check && !check) {
    log.step('голоса актёров: сервис на сервере не умеет проверять реплики — обновите его (scripts/server/install-worker.sh)');
  }
  const attempts = check ? CHECK_ATTEMPTS : 1;

  let voiced = 0;
  let reused = 0;
  let failed = 0;
  let firstFailure: string | null = null;
  let serverGone = false;
  let done = 0;
  let retried = 0;
  const flagged: Segment[] = [];

  const voiceOne = async (segment: Segment): Promise<void> => {
    const ref = refKeys.get(segment.speaker)!;
    const duration = Number(segment.aligned_duration!.toFixed(2));
    const key = sha256(JSON.stringify([MODEL_TAG, ref.key, segment.text_ru, duration, config.tts.clone.steps]));
    const target = path.join(cloneDir, `${String(segment.id).padStart(4, '0')}.wav`);

    if (segment.clone_key === key && existsSync(target) && fitsLength(await wavDuration(target), duration)) {
      reused++;
    } else if (serverGone) {
      failed++;
      return;
    } else {
      try {
        const raw = `${target}.24k.wav`;
        /*
         * X-Voice ошибается в отдельных репликах и каждый раз по-разному, поэтому
         * неудачную реплику просто озвучиваем ещё раз. Из попыток берётся лучшая
         * по проверке; без проверки попытка одна, как раньше.
         */
        let best: { audio: Buffer; verdict: ClipVerdict | null } | null = null;
        let lengthError: string | null = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          if (attempt > 1) retried++;
          const { audio, heard } = await cloneSpeech(config, {
            ref: ref.key,
            ref_text: ref.text,
            ref_lang: config.asr.language,
            text: segment.text_ru!,
            duration,
            steps: config.tts.clone.steps,
            check,
          });
          await writeFile(raw, audio);
          const got = await wavDuration(raw);
          if (!fitsLength(got, duration)) {
            // Длина — это и есть укладка: клип длиннее заказа наезжает на соседа.
            lengthError = `X-Voice вернул ${got.toFixed(1)} с вместо ${duration.toFixed(1)} с`;
            continue;
          }
          const verdict = heard === null ? null : judgeClip(segment.text_ru!, heard);
          if (!best || (verdict && best.verdict && verdict.score > best.verdict.score)) best = { audio, verdict };
          if (!verdict || verdict.ok) break;
          log.debug(`голос актёра, реплика ${segment.id} (${clock(segment.start)}): ${verdict.problems.join(', ')} — слышно «${heard}», попытка ${attempt}`);
        }
        if (!best) throw new CloneError(lengthError ?? 'X-Voice не озвучил реплику', 200);
        await writeFile(raw, best.audio);
        // К формату конвейера: частота и раскладка — как у остальных клипов сведения.
        await run(ffmpeg, ['-y', '-v', 'error', '-i', raw, '-ar', String(config.tts.sample_rate), '-ac', '1', '-acodec', 'pcm_s16le', target], {
          timeoutMs: 60_000,
        });
        await rm(raw, { force: true });
        if (best.verdict && !best.verdict.ok) flagged.push(segment);
        voiced++;
      } catch (error) {
        if (isCancelled(error)) throw error;
        failed++;
        firstFailure ??= (error as Error).message;
        // До сервера не дошли — остальные реплики и спрашивать незачем.
        if (!(error instanceof CloneError)) serverGone = true;
        return;
      }
    }
    segment.clone_key = key;
    segment.aligned_file = target;
    segment.aligned_duration = Number((await wavDuration(target)).toFixed(3));
  };

  // Две реплики в пути: сервер считает одну, вторая в это время едет по сети.
  const queue = [...pending];
  const worker = async (): Promise<void> => {
    for (let segment = queue.shift(); segment; segment = queue.shift()) {
      cancellation.throwIfCancelled();
      await voiceOne(segment);
      done++;
      log.progress(`голоса актёров ${done}/${pending.length}`, null, { done, total: pending.length }, {
        key: 'work.clone',
        params: { done, total: pending.length },
      });
      if (done % 20 === 0 || done === pending.length) log.step(`голосами актёров: ${done}/${pending.length}`);
    }
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, worker));

  if (failed > 0) {
    warnings.push(
      warn(
        'warn.clone.failed',
        `${failed} реплик не озвучены голосом актёра (${firstFailure ?? 'сервер отказал'}) — они говорят базовым голосом`,
        { count: failed, reason: firstFailure ?? '' },
      ),
    );
  }
  if (flagged.length > 0) {
    const lines = flagged
      .sort((a, b) => a.start - b.start)
      .slice(0, 12)
      .map((segment) => clock(segment.start))
      .join(', ');
    warnings.push(
      warn(
        'warn.clone.flagged',
        `${flagged.length} реплик голосом актёра и после ${attempts} попыток звучат с ошибками — стоит послушать: ${lines}`,
        { count: flagged.length, attempts, lines },
      ),
    );
  }
  log.step(`голоса актёров: озвучено ${voiced}, из кэша ${reused}, базовым голосом ${failed}`);
  if (check) log.step(`проверка голосов актёров: повторных озвучек ${retried}, с замечаниями ${flagged.length}`);
  return { provider, voiced, reused, failed, retried, flagged: flagged.length, speakers: references };
}

export interface SpeakerReferences {
  /** Что выбрал человек: номер реплики, `off` или ничего — выбор за программой. */
  chosen: number | 'off' | null;
  /** Что выбрала бы программа сама. */
  auto: ReferenceCandidate | null;
  /** Из чего выбирать, лучшие первыми. */
  candidates: ReferenceCandidate[];
}

export interface ReferenceOverview {
  /** Звук, с которого снимаются образцы: отделённый голос или оригинал. */
  source: string | null;
  speakers: Record<string, SpeakerReferences>;
}

/** Сколько кандидатов показывать человеку: дальше — всё менее годные реплики. */
const SHOWN_CANDIDATES = 8;

/** Образцы голосов для панели «Голоса и персонажи». */
export async function referenceOverview(
  workspace: Workspace,
  config: DubConfig,
  segments: Segment[],
  overrides: ProjectOverrides,
): Promise<ReferenceOverview> {
  const turns = await readTurns(workspace);
  const options = { charsPerSecond: languageProfile(config.asr.language).subtitleCps };
  // «Сама программа» выбрала бы то же, что при озвучке, — с проверкой пауз.
  const auto = await chooseReferences(workspace, config, segments, { ...overrides, refs: {} });
  const speakers: Record<string, SpeakerReferences> = {};
  for (const speaker of [...new Set(segments.map((segment) => segment.speaker))].sort()) {
    speakers[speaker] = {
      chosen: overrides.refs?.[speaker] ?? null,
      auto: auto[speaker] ?? null,
      candidates: referenceCandidates(segments, turns, speaker, options).slice(0, SHOWN_CANDIDATES),
    };
  }
  return { source: referenceSource(workspace), speakers };
}

/** Образец персонажа уже снят и лежит в рабочем каталоге. */
export async function referenceAudio(workspace: Workspace, speaker: string): Promise<Buffer | null> {
  const file = referencePath(workspace, speaker);
  return existsSync(file) ? await readFile(file) : null;
}
