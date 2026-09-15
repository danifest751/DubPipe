import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { packageRoot } from '../config/load.js';
import type { DubConfig } from '../config/schema.js';
import { cancellation } from '../core/cancel.js';
import { StageError } from '../core/errors.js';
import { counter, log } from '../core/logger.js';
import { availableSeconds, slotOf, warn, type Segment, type StageWarning } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import { applyOverrides } from '../core/overrides.js';
import { selectChatClient, type ChatClient } from '../providers/llm/index.js';
import { createTtsProvider, voiceForSpeaker } from '../providers/tts/index.js';
import { recordClip } from './s5-tts.js';
import { buildAtempoChain } from '../util/ffmpeg.js';
import { spreadPausesInClip } from './s6-pauses.js';
import { run } from '../util/exec.js';
import { requireTool } from '../util/tools.js';
import { wavDuration } from '../util/wav.js';
import { estimateSpeechSeconds, profanityRule } from './s3-translate.js';
import { effectiveSpeechShape } from '../core/calibration.js';

/**
 * S6 — fitting synthesis to the timeline (SPEC FR-6).
 *
 * Placement, tempo and drift control are computed by a pure function so the
 * rules can be tested without ffmpeg or a model; the stage then renders what
 * the plan says.
 */

export interface AlignmentOptions {
  minTempo: number;
  maxTempo: number;
  gapMs: number;
  /** Сколько тишины после реплики можно занять под её речь. */
  borrowSilenceMs: number;
  maxShiftMs: number;
  driftResetGapMs: number;
}

export interface AlignmentPlanItem {
  id: number;
  /** Where the replica actually starts after shifting. */
  alignedStart: number;
  shiftMs: number;
  tempo: number;
  /** Duration after the tempo change. */
  effectiveDuration: number;
  /** Set when the clip must be cut to fit; the tail gets a fade-out. */
  truncateTo: number | null;
  /** True when even maximum tempo does not fit — the text has to get shorter. */
  needsShorten: boolean;
  slot: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Lays replicas onto the timeline.
 *
 * Rules, in the order the spec states them: pad short clips (nothing to do
 * here — placement handles it), speed up clips that fit within max tempo,
 * flag the rest for shortening, keep a gap between replicas, and never let the
 * accumulated shift exceed the limit. The shift resets to zero after any pause
 * longer than `driftResetGapMs`, which is what stops a long video from drifting
 * seconds out of sync (SPEC FR-6.5).
 */
export function planAlignment(segments: Segment[], options: AlignmentOptions): AlignmentPlanItem[] {
  const gap = options.gapMs / 1000;
  const maxShift = options.maxShiftMs / 1000;
  const resetGap = options.driftResetGapMs / 1000;

  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const borrow = options.borrowSilenceMs / 1000;
  const plan: AlignmentPlanItem[] = [];

  let previousAlignedEnd: number | null = null;
  let previousOriginalEnd: number | null = null;

  for (const [index, segment] of ordered.entries()) {
    const slot = slotOf(segment);
    /*
     * Пауза после реплики — такое же место для речи, как и сама реплика: там
     * всё равно тишина. Занимать её выгоднее, чем сокращать перевод, потому
     * что сокращение теряет смысл, а сдвиг конца на секунду не замечается.
     *
     * Замер на 35-минутном эпизоде: из 22 реплик, не влезавших даже на
     * максимальном темпе, 21 укладывается, если занять паузу — в среднем
     * секунду. Предел нужен, иначе реплика уедет от картинки: перед длинной
     * паузой занимать все её десять секунд бессмысленно.
     */
    const available = availableSeconds(ordered, index, { borrowSeconds: borrow, gapSeconds: gap });
    const duration = segment.tts_duration ?? slot;

    let tempo = 1;
    if (available > 0 && duration > available) tempo = clamp(duration / available, options.minTempo, options.maxTempo);
    let effective = duration / tempo;
    const needsShorten = effective > available + 1e-6;

    const pauseBefore = previousOriginalEnd === null ? Infinity : segment.start - previousOriginalEnd;
    const driftReset = pauseBefore > resetGap;

    let alignedStart: number;
    if (previousAlignedEnd === null || driftReset) {
      // A long pause absorbs any lateness: start back on the original timecode.
      alignedStart = Math.max(segment.start, driftReset && previousAlignedEnd !== null ? previousAlignedEnd + gap : segment.start);
    } else {
      alignedStart = Math.max(segment.start, previousAlignedEnd + gap);
    }

    let shift = alignedStart - segment.start;
    let truncateTo: number | null = null;

    if (shift > maxShift) {
      // Out of room: take the maximum tempo and, if that is still not enough,
      // cut the tail rather than drift further (SPEC FR-6.5).
      shift = maxShift;
      alignedStart = segment.start + maxShift;
      tempo = available > 0 && duration > available ? options.maxTempo : tempo;
      effective = duration / tempo;
      if (effective > available) truncateTo = available;
    }

    if (truncateTo !== null) effective = truncateTo;

    plan.push({
      id: segment.id,
      alignedStart: Number(alignedStart.toFixed(3)),
      shiftMs: Math.round(shift * 1000),
      tempo: Number(tempo.toFixed(4)),
      effectiveDuration: Number(effective.toFixed(3)),
      truncateTo,
      needsShorten,
      slot: Number(available.toFixed(3)),
    });

    previousAlignedEnd = alignedStart + effective;
    previousOriginalEnd = segment.end;
  }

  return plan;
}

export interface AlignmentStats {
  count: number;
  medianShiftMs: number;
  maxShiftMs: number;
  outsideToleranceShare: number;
  speedUp: number;
  truncated: number;
}

/** Aggregate for the run report (SPEC FR-6.6). */
export function alignmentStats(plan: AlignmentPlanItem[], toleranceMs = 250): AlignmentStats {
  if (plan.length === 0) {
    return { count: 0, medianShiftMs: 0, maxShiftMs: 0, outsideToleranceShare: 0, speedUp: 0, truncated: 0 };
  }
  const shifts = plan.map((item) => Math.abs(item.shiftMs)).sort((a, b) => a - b);
  const middle = Math.floor(shifts.length / 2);
  const median = shifts.length % 2 === 0 ? (shifts[middle - 1]! + shifts[middle]!) / 2 : shifts[middle]!;

  return {
    count: plan.length,
    medianShiftMs: Math.round(median),
    maxShiftMs: shifts[shifts.length - 1]!,
    outsideToleranceShare: shifts.filter((value) => value > toleranceMs).length / shifts.length,
    speedUp: plan.filter((item) => item.tempo > 1.001).length,
    truncated: plan.filter((item) => item.truncateTo !== null).length,
  };
}

/**
 * Сколько знаков влезет в слот на максимальном темпе (ТЗ FR-6.3).
 *
 * Длительность реплики — надбавка плюс знаки, делённые на темп; ускорение
 * сжимает и то, и другое. Отсюда `(слот · темп_ускорения − надбавка) · темп`.
 * Без вычитания надбавки у коротких реплик просили больше, чем в них влезает,
 * и сокращение не помогало — реплика всё равно не укладывалась.
 */
export function shortenTargetChars(
  slotSeconds: number,
  charsPerSecond: number,
  maxTempo: number,
  overheadSeconds = 0,
): number {
  const speaking = Math.max(0, slotSeconds * maxTempo - overheadSeconds);
  return Math.max(4, Math.round(speaking * charsPerSecond));
}

/**
 * Ожидание с пределом: ни один шаг стадии не должен висеть молча.
 *
 * Сокращение реплик — единственное место укладки, где ходят наружу, и оно
 * подвесило прогон целиком: за десять минут ни строки в журнале, процессорное
 * время не росло, сокетов не было. Человек видел «ожидает» и не мог понять,
 * работает программа или умерла. Предел превращает зависание в обычный отказ:
 * реплика останется несокращённой, и стадия пойдёт дальше.
 */
async function withLimit<T>(work: Promise<T>, seconds: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} не ответило за ${seconds} с`)), seconds * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shortenReplica(
  client: ChatClient,
  template: string,
  segment: Segment,
  targetChars: number,
  profanity: string,
  availableSlotSeconds: number,
): Promise<string | null> {
  const prompt = template
    .replace('{target_chars}', String(targetChars))
    // Модели называется то же место, из которого посчитано число знаков:
    // иначе ей говорят «у тебя полсекунды», а просят двадцать знаков.
    .replace('{slot_seconds}', availableSlotSeconds.toFixed(2))
    .replace('{text_ru}', segment.text_ru ?? '')
    .replace('{profanity_rule}', profanity);

  try {
    const reply = await client.complete(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: segment.text_ru ?? '' },
      ],
      { temperature: 0.2 },
    );
    const text = reply.text.trim().replace(/^["'«]|["'»]$/g, '');
    return text.length > 0 && text.length < (segment.text_ru?.length ?? 0) ? text : null;
  } catch (error) {
    log.debug(`сокращение реплики ${segment.id} не удалось: ${(error as Error).message}`);
    return null;
  }
}

export interface S6Result {
  segments: Segment[];
  warnings: StageWarning[];
  stats: AlignmentStats;
  provider: string;
}

export async function runS6(workspace: Workspace, baseConfig: DubConfig, segments: Segment[]): Promise<S6Result> {
  const config = applyOverrides(baseConfig, await workspace.readOverrides(), await workspace.readSpeakers());
  const warnings: StageWarning[] = [];
  const { charsPerSecond, overheadSeconds } = await effectiveSpeechShape(workspace, config);
  const options: AlignmentOptions = {
    minTempo: config.alignment.min_tempo,
    maxTempo: config.alignment.max_tempo,
    gapMs: config.alignment.gap_ms,
    borrowSilenceMs: config.alignment.borrow_silence_ms,
    maxShiftMs: config.alignment.max_shift_ms,
    driftResetGapMs: config.alignment.drift_reset_gap_ms,
  };

  // Shorten replicas that cannot fit even at maximum tempo, then resynthesise.
  let plan = planAlignment(segments, options);
  const needShorten = plan.filter((item) => item.needsShorten);

  if (needShorten.length > 0 && config.alignment.max_retranslate > 0) {
    log.step(`не укладываются в слот: ${needShorten.length} — сокращаю через модель`);
    const template = await readFile(path.join(packageRoot(), 'prompts', 'shorten.md'), 'utf8');
    // Строка о ходе — до первого запроса: иначе полоса стоит «ожидает», пока
    // стадия уже работает, и непонятно, жива ли она.
    log.progress(`сокращение реплик 0/${needShorten.length}`, null, { done: 0, total: needShorten.length }, {
      key: 'work.shorten',
      params: { done: 0, total: needShorten.length, iteration: 1 },
    });
    const selection = await withLimit(selectChatClient(config), 120, 'выбор модели');
    warnings.push(...selection.warnings);
    const tts = createTtsProvider(workspace, config);
    const byId = new Map(segments.map((segment) => [segment.id, segment]));

    for (let iteration = 1; iteration <= config.alignment.max_retranslate; iteration++) {
      const current = planAlignment(segments, options).filter((item) => item.needsShorten);
      if (current.length === 0) break;

      let fixed = 0;
      for (const [index, item] of current.entries()) {
        const segment = byId.get(item.id);
        if (!segment?.text_ru) continue;

        const target = shortenTargetChars(item.slot, charsPerSecond, options.maxTempo, overheadSeconds);
        let shortened: string | null = null;
        try {
          shortened = await withLimit(
            shortenReplica(selection.client, template, segment, target, profanityRule(config.translate.profanity), item.slot),
            180,
            `сокращение реплики ${segment.id}`,
          );
        } catch (error) {
          log.warn(`сокращение реплики ${segment.id} пропущено: ${(error as Error).message}`);
        }
        if (!shortened) continue;
        cancellation.throwIfCancelled();

        segment.text_ru = shortened;
        // Разметка фраз была сделана по прежнему тексту: теперь она лжёт, и
        // синтез по ней произнёс бы то, что мы только что сократили.
        segment.phrases = null;
        segment.retranslate_count++;
        const voice = voiceForSpeaker(segment.speaker, config.tts.voice_map, config.tts.default_voice);
        const result = await tts.synthesize({
          id: segment.id,
          text: shortened,
          voice,
          outputPath: segment.tts_file ?? path.join(await workspace.subdir('tts'), `${String(segment.id).padStart(4, '0')}.wav`),
        });
        recordClip(segment, result, voice, shortened, tts.fingerprint);
        fixed++;
        log.step(`сокращено ${counter(index + 1, current.length)} (итерация ${iteration})`);
        log.progress(
          `сокращено реплик ${counter(index + 1, current.length)}, итерация ${iteration}`,
          null,
          { done: index + 1, total: current.length },
          { key: 'work.shorten', params: { done: index + 1, total: current.length, iteration } },
        );
      }
      if (fixed === 0) break;
    }
    plan = planAlignment(segments, options);
  }

  // Render every clip at its planned tempo.
  const ffmpeg = await requireTool('ffmpeg', workspace.toolsDir);
  const alignedDir = await workspace.subdir('aligned');
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  let rendered = 0;
  let spreadSeconds = 0;
  let spreadLines = 0;

  for (const item of plan) {
    const segment = byId.get(item.id);
    if (!segment?.tts_file) continue;

    const target = path.join(alignedDir, `${String(segment.id).padStart(4, '0')}.wav`);
    const filters = buildAtempoChain(item.tempo);
    if (item.truncateTo !== null) {
      // Cut with a short fade so the truncation does not click.
      const fade = Math.min(0.05, item.truncateTo / 4);
      filters.push(`atrim=0:${item.truncateTo.toFixed(3)}`, `afade=t=out:st=${Math.max(0, item.truncateTo - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
      if (!segment.flags.includes('truncated')) segment.flags.push('truncated');
    }

    const args = ['-y', '-v', 'error', '-i', segment.tts_file];
    if (filters.length > 0) args.push('-filter:a', filters.join(','));
    args.push('-ar', String(config.tts.sample_rate), '-ac', '1', '-acodec', 'pcm_s16le', target);
    await run(ffmpeg, args, { timeoutMs: 120_000 });

    /*
     * Недостающее время — по паузам внутри реплики, а не дырой в конце.
     *
     * Слот на три секунды и речь на полторы означали полторы секунды тишины под
     * ещё шевелящимися губами. Раньше эту дыру пытались закрыть текстом, и
     * модель дописывала отсутствующее в оригинале. Теперь тишина раскладывается
     * по местам, где синтезатор и сам замолчал, с весом по паузам оригинала —
     * это и есть «prosodic alignment» из работ по автоматическому дубляжу,
     * только без пересинтеза фраз. Остаток, как и требует ТЗ FR-6.1, остаётся
     * в конце.
     */
    /*
     * Нехватка считается от слота, а не от занятой паузы.
     *
     * `item.slot` — это слот плюс тишина, взятая взаймы у соседа: она нужна
     * длинной реплике, чтобы не ускоряться. Если считать нехватку от неё,
     * тишина дольётся туда, где оригинал уже замолчал, и дубляж будет тянуться
     * после закрытого рта — ровно та беда, от которой уходим.
     */
    const slack = slotOf(segment) - (await wavDuration(target));
    if (slack > 0) {
      const spread = await spreadPausesInClip(target, slack, segment.words);
      if (spread.added > 0) {
        spreadSeconds += spread.added;
        spreadLines++;
      }
    }

    segment.aligned_file = target;
    segment.tempo = item.tempo;
    segment.shift_ms = item.shiftMs;
    // Длительность уложенного клипа — в своё поле. Записанная поверх
    // `tts_duration`, она на следующем прогоне выдавала себя за длительность
    // синтеза: план видел уже ускоренный клип, брал темп 1.0 и клал реплику
    // неускоренной поверх соседней.
    segment.aligned_duration = Number((await wavDuration(target)).toFixed(3));
    rendered++;
  }

  if (rendered === 0) {
    throw new StageError('s6', 'нет синтезированных реплик для подгонки', {
      hints: ['Сначала выполните стадию s5'],
    });
  }

  if (spreadLines > 0) {
    log.step(`пауза разложена внутри реплик: ${spreadLines}, всего ${spreadSeconds.toFixed(2)} с`);
  }

  const stats = alignmentStats(plan);
  log.step(
    `сдвиг: медиана ${stats.medianShiftMs} мс, максимум ${stats.maxShiftMs} мс; ` +
      `ускорено ${stats.speedUp}, обрезано ${stats.truncated}`,
  );
  if (stats.outsideToleranceShare > 0.1) {
    const driftShare = Math.round(stats.outsideToleranceShare * 100);
    warnings.push(
      warn(
        'warn.s6.drift',
        `${driftShare}% реплик сдвинуты больше чем на 250 мс ` +
          '(ТЗ M3 требует не более 10%). Проверьте длину переводов и alignment.max_tempo',
        { share: driftShare },
      ),
    );
  }
  if (stats.truncated > 0) {
    warnings.push(
      warn('warn.s6.truncated', `${stats.truncated} реплик обрезаны по слоту — они помечены флагом truncated`, {
        count: stats.truncated,
      }),
    );
  }

  await workspace.writeSegments(segments);
  await workspace.writeJson(workspace.file('alignment.json'), { options, stats, plan });

  return { segments, warnings, stats, provider: 'ffmpeg atempo' };
}

/** Placement used by S7 when S6 is disabled: originals, no tempo change. */
export function passthroughPlan(segments: Segment[]): AlignmentPlanItem[] {
  return segments.map((segment) => ({
    id: segment.id,
    alignedStart: segment.start,
    shiftMs: 0,
    tempo: 1,
    effectiveDuration: segment.tts_duration ?? slotOf(segment),
    truncateTo: null,
    needsShorten: (segment.tts_duration ?? 0) > slotOf(segment),
    slot: slotOf(segment),
  }));
}

/** Estimated spoken length, re-exported so S6 callers need one import. */
export { estimateSpeechSeconds };
