import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { packageRoot } from '../config/load.js';
import type { DubConfig } from '../config/schema.js';
import { cancellation } from '../core/cancel.js';
import { StageError } from '../core/errors.js';
import { counter, log } from '../core/logger.js';
import { slotOf, type Segment } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import { applyOverrides } from '../core/overrides.js';
import { selectChatClient, type ChatClient } from '../providers/llm/index.js';
import { createTtsProvider, voiceForSpeaker } from '../providers/tts/index.js';
import { buildAtempoChain } from '../util/ffmpeg.js';
import { run } from '../util/exec.js';
import { requireTool } from '../util/tools.js';
import { wavDuration } from '../util/wav.js';
import { estimateSpeechSeconds, profanityRule } from './s3-translate.js';

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
    const next = ordered[index + 1];
    const room = Math.max(
      0,
      Math.min(borrow, (next ? next.start - gap : segment.end + borrow) - segment.end),
    );
    const available = slot + room;
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

/** Character budget that fits the slot at maximum tempo (SPEC FR-6.3). */
export function shortenTargetChars(slotSeconds: number, charsPerSecond: number, maxTempo: number): number {
  return Math.max(4, Math.round(slotSeconds * charsPerSecond * maxTempo));
}

async function shortenReplica(
  client: ChatClient,
  template: string,
  segment: Segment,
  targetChars: number,
  profanity: string,
): Promise<string | null> {
  const prompt = template
    .replace('{target_chars}', String(targetChars))
    .replace('{slot_seconds}', slotOf(segment).toFixed(2))
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
  warnings: string[];
  stats: AlignmentStats;
  provider: string;
}

/** Calibrated speech rate from S5, falling back to the configured estimate. */
export async function effectiveCharsPerSecond(workspace: Workspace, config: DubConfig): Promise<number> {
  const calibration = await workspace.readJson<{ chars_per_second?: number }>(workspace.file('calibration.json'));
  const measured = calibration?.chars_per_second;
  return measured && measured >= 5 && measured <= 30 ? measured : config.translate.chars_per_second;
}

export async function runS6(workspace: Workspace, baseConfig: DubConfig, segments: Segment[]): Promise<S6Result> {
  const config = applyOverrides(baseConfig, await workspace.readOverrides(), await workspace.readSpeakers());
  const warnings: string[] = [];
  const charsPerSecond = await effectiveCharsPerSecond(workspace, config);
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
    const selection = await selectChatClient(config);
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

        const target = shortenTargetChars(item.slot, charsPerSecond, options.maxTempo);
        const shortened = await shortenReplica(
          selection.client,
          template,
          segment,
          target,
          profanityRule(config.translate.profanity),
        );
        if (!shortened) continue;
        cancellation.throwIfCancelled();

        segment.text_ru = shortened;
        segment.retranslate_count++;
        const voice = voiceForSpeaker(segment.speaker, config.tts.voice_map, config.tts.default_voice);
        const result = await tts.synthesize({
          id: segment.id,
          text: shortened,
          voice,
          outputPath: segment.tts_file ?? path.join(await workspace.subdir('tts'), `${String(segment.id).padStart(4, '0')}.wav`),
        });
        segment.tts_file = result.path;
        segment.tts_duration = Number(result.durationSeconds.toFixed(3));
        fixed++;
        log.step(`сокращено ${counter(index + 1, current.length)} (итерация ${iteration})`);
        log.progress(`сокращено реплик ${counter(index + 1, current.length)}, итерация ${iteration}`, null, {
          done: index + 1,
          total: current.length,
        });
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

    segment.aligned_file = target;
    segment.tempo = item.tempo;
    segment.shift_ms = item.shiftMs;
    segment.tts_duration = Number((await wavDuration(target)).toFixed(3));
    rendered++;
  }

  if (rendered === 0) {
    throw new StageError('s6', 'нет синтезированных реплик для подгонки', {
      hints: ['Сначала выполните стадию s5'],
    });
  }

  const stats = alignmentStats(plan);
  log.step(
    `сдвиг: медиана ${stats.medianShiftMs} мс, максимум ${stats.maxShiftMs} мс; ` +
      `ускорено ${stats.speedUp}, обрезано ${stats.truncated}`,
  );
  if (stats.outsideToleranceShare > 0.1) {
    warnings.push(
      `${Math.round(stats.outsideToleranceShare * 100)}% реплик сдвинуты больше чем на 250 мс ` +
        '(ТЗ M3 требует не более 10%). Проверьте длину переводов и alignment.max_tempo',
    );
  }
  if (stats.truncated > 0) {
    warnings.push(`${stats.truncated} реплик обрезаны по слоту — они помечены флагом truncated`);
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
