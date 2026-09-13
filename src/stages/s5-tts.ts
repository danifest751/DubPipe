import path from 'node:path';
import { existsSync } from 'node:fs';
import type { DubConfig } from '../config/schema.js';
import { cancellation } from '../core/cancel.js';
import { counter, log } from '../core/logger.js';
import { slotOf, type Segment } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import { applyOverrides } from '../core/overrides.js';
import { createTtsProvider, voiceForSpeaker } from '../providers/tts/index.js';

/**
 * S5 — speech synthesis, one clip per replica (SPEC FR-5).
 * Produces: tts/NNNN.wav, plus tts_file and tts_duration on every segment.
 */

export interface S5Result {
  segments: Segment[];
  provider: string;
  warnings: string[];
  /** Measured characters per second, fed back into the FR-3 length estimate. */
  measuredCps: number | null;
}

/**
 * Actual speech rate of the synthesised clips. S3 estimates replica length from
 * a configured characters-per-second value; measuring it here lets the user
 * calibrate that number for their voice instead of guessing (SPEC FR-5).
 */
export function measureCharsPerSecond(segments: Segment[]): number | null {
  const usable = segments.filter(
    (segment) => segment.text_ru && segment.tts_duration !== null && segment.tts_duration > 0.2,
  );
  if (usable.length < 3) return null;

  const chars = usable.reduce((sum, segment) => sum + segment.text_ru!.trim().length, 0);
  const seconds = usable.reduce((sum, segment) => sum + segment.tts_duration!, 0);
  return seconds > 0 ? Number((chars / seconds).toFixed(2)) : null;
}

/** Runs tasks with a bounded number in flight (SPEC §5.3: tts.concurrency). */
async function withConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      cancellation.throwIfCancelled();
      const index = cursor++;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

export async function runS5(workspace: Workspace, baseConfig: DubConfig, segments: Segment[]): Promise<S5Result> {
  // Голоса, назначенные в режиме просмотра этого видео, важнее общих настроек.
  const config = applyOverrides(baseConfig, await workspace.readOverrides(), await workspace.readSpeakers());
  const warnings: string[] = [];
  const provider = createTtsProvider(workspace, config);
  const outputDir = await workspace.subdir('tts');

  const pending = segments.filter((segment) => segment.text_ru && segment.text_ru.trim().length > 0);
  if (pending.length === 0) {
    return { segments, provider: provider.name, warnings: ['Нет переведённых реплик для синтеза'], measuredCps: null };
  }

  const voices = new Set<string>();
  for (const segment of pending) {
    voices.add(voiceForSpeaker(segment.speaker, config.tts.voice_map, config.tts.default_voice));
  }
  log.step(`синтез ${pending.length} реплик, голосов: ${[...voices].join(', ')}`);

  let done = 0;
  await withConcurrency(pending, config.tts.concurrency, async (segment) => {
    const outputPath = path.join(outputDir, `${String(segment.id).padStart(4, '0')}.wav`);
    const voice = voiceForSpeaker(segment.speaker, config.tts.voice_map, config.tts.default_voice);

    // Re-running the stage should not resynthesise clips that already exist and
    // still match the text (the cache key covers config, this covers restarts).
    if (existsSync(outputPath) && segment.tts_file === outputPath && segment.tts_duration !== null) {
      done++;
      return;
    }

    const result = await provider.synthesize({ id: segment.id, text: segment.text_ru!, voice, outputPath });
    segment.tts_file = result.path;
    segment.tts_duration = Number(result.durationSeconds.toFixed(3));

    done++;
    log.progress(`синтезировано реплик ${counter(done, pending.length)}`, null, { done, total: pending.length });
    if (done % 10 === 0 || done === pending.length) log.step(`синтезировано ${counter(done, pending.length)}`);
  });

  const overlong = pending.filter(
    (segment) => segment.tts_duration !== null && segment.tts_duration > slotOf(segment) * config.alignment.max_tempo,
  );
  if (overlong.length > 0) {
    const share = ((overlong.length / pending.length) * 100).toFixed(0);
    warnings.push(
      `${overlong.length} реплик (${share}%) не укладываются в слот даже при максимальном темпе — ` +
        (config.alignment.enabled
          ? 'стадия S6 сократит их через LLM'
          : 'стадия S6 отключена, реплики будут наезжать друг на друга'),
    );
  }

  const measuredCps = measureCharsPerSecond(pending);
  if (measuredCps !== null) {
    // Later stages size their targets from the real rate of this voice rather
    // than the configured guess (SPEC FR-5).
    await workspace.writeJson(workspace.file('calibration.json'), {
      chars_per_second: measuredCps,
      voice: config.tts.default_voice,
      measured_at: new Date().toISOString(),
      samples: pending.length,
    });
    const configured = config.translate.chars_per_second;
    const drift = Math.abs(measuredCps - configured) / configured;
    log.step(`фактический темп речи: ${measuredCps} симв/с (в конфиге ${configured})`);
    if (drift > 0.12) {
      warnings.push(
        `Фактический темп синтеза ${measuredCps} симв/с заметно отличается от настройки ` +
          `translate.chars_per_second = ${configured}. Уточните её, чтобы S3 точнее попадал в слот`,
      );
    }
  }

  await workspace.writeSegments(segments);
  return { segments, provider: provider.name, warnings, measuredCps };
}
