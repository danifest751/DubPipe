import path from 'node:path';
import { existsSync } from 'node:fs';
import type { DubConfig } from '../config/schema.js';
import { cancellation } from '../core/cancel.js';
import { counter, log } from '../core/logger.js';
import { availableSeconds, slotOf, type Segment } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import { applyOverrides } from '../core/overrides.js';
import { createTtsProvider, voiceForSpeaker } from '../providers/tts/index.js';
import { effectiveSpeechShape, rememberCalibration } from '../core/calibration.js';
import { sha256 } from '../util/hash.js';

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
/**
 * Измеряет, как этот голос переводит знаки в секунды.
 *
 * Одним числом не обойтись: у каждой реплики есть постоянная надбавка — подход
 * к фразе и хвост после неё. Замер на 255 репликах: реплики короче 15 знаков
 * идут со скоростью 10.2 знака в секунду, длиннее 80 — со скоростью 16.6, хотя
 * голос один. Поэтому подгоняется прямая `длительность = надбавка + знаки /
 * темп`; на том же материале она дала 0.51 с и 17.8 знака в секунду и ошиблась
 * больше чем на четверть лишь на 15% реплик против половины у одного темпа.
 */
export function measureSpeechRate(segments: Segment[]): { charsPerSecond: number; overheadSeconds: number } | null {
  const usable = segments.filter(
    (segment) => segment.text_ru && segment.tts_duration !== null && segment.tts_duration > 0.2,
  );
  if (usable.length < 8) return null;

  const points = usable.map((segment) => ({ chars: segment.text_ru!.trim().length, seconds: segment.tts_duration! }));
  const n = points.length;
  const sumX = points.reduce((sum, p) => sum + p.chars, 0);
  const sumY = points.reduce((sum, p) => sum + p.seconds, 0);
  const sumXX = points.reduce((sum, p) => sum + p.chars * p.chars, 0);
  const sumXY = points.reduce((sum, p) => sum + p.chars * p.seconds, 0);
  // Запасной путь: средний темп без надбавки. Нужен, когда подгонка бессильна —
  // все реплики одной длины (наклон не определить) или прямая пошла вниз.
  const averageRate = sumY > 0 ? sumX / sumY : 0;
  const average = () =>
    averageRate >= 5 && averageRate <= 30
      ? { charsPerSecond: Number(averageRate.toFixed(2)), overheadSeconds: 0 }
      : null;

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return average();

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  if (slope <= 0) return average();
  const rate = 1 / slope;
  if (!(rate >= 5 && rate <= 40)) return average();
  return {
    charsPerSecond: Number(rate.toFixed(2)),
    overheadSeconds: Number(Math.max(0, Math.min(2, intercept)).toFixed(3)),
  };
}

/**
 * Отпечаток озвучки: чем, каким голосом и из какого текста сделан файл.
 *
 * Отпечаток движка нужен наравне с голосом. Частота дискретизации задаётся
 * настройкой, а клип сводится именно в ней: сменив её, мы меняли отпечаток
 * стадии, стадия запускалась — и пропускала каждую реплику, потому что голос
 * и текст остались прежними. На диске оставались клипы в прежней частоте, и
 * при выключенной укладке дорожка собиралась из них с чужой скоростью.
 */
export function ttsKey(voice: string, text: string, engine: string): string {
  return sha256(`${engine}\u0000${voice}\u0000${text.trim()}`).slice(0, 16);
}

/**
 * Записывает реплике, что за клип у неё теперь: файл, длительность и отпечаток
 * того, из чего он сделан.
 *
 * Одной функцией, потому что клип пишут две стадии — синтез и укладка,
 * переозвучивающая сокращённые реплики. Укладка однажды забыла обновить
 * отпечаток, и клип с сокращённым текстом остался подписан прежним.
 */
export function recordClip(
  segment: Segment,
  clip: { path: string; durationSeconds: number },
  voice: string,
  text: string,
  engine: string,
): void {
  segment.tts_file = clip.path;
  segment.tts_duration = Number(clip.durationSeconds.toFixed(3));
  segment.tts_key = ttsKey(voice, text, engine);
  // Свежий клип ещё не уложен, и прежняя укладка к нему не относится. Без
  // этого при выключенной S6 сведение брало старый уложенный файл: реплика
  // звучала прежним текстом, хотя перевод давно переписан.
  segment.aligned_file = null;
  segment.aligned_duration = null;
  segment.tempo = null;
  segment.shift_ms = null;
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

    // Повторный запуск не переозвучивает то, что уже озвучено тем же движком,
    // голосом и текстом. Проверять только наличие файла нельзя: смена голоса
    // тогда не меняет ничего, файлы-то на месте.
    const key = ttsKey(voice, segment.text_ru!, provider.fingerprint);
    if (
      existsSync(outputPath) &&
      segment.tts_file === outputPath &&
      segment.tts_duration !== null &&
      segment.tts_key === key
    ) {
      done++;
      return;
    }

    const result = await provider.synthesize({ id: segment.id, text: segment.text_ru!, voice, outputPath });
    recordClip(segment, result, voice, segment.text_ru!, provider.fingerprint);

    done++;
    log.progress(`синтезировано реплик ${counter(done, pending.length)}`, null, { done, total: pending.length });
    if (done % 10 === 0 || done === pending.length) log.step(`синтезировано ${counter(done, pending.length)}`);
  });

  // Место считается так же, как его считают перевод и укладка: слот плюс
  // занимаемая пауза. По голому слоту предупреждение пугало впустую — на
  // редком на диалог материале оно насчитывало 39% там, где укладка не
  // сократила ни одной реплики.
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const roomOf = new Map(
    ordered.map((segment, index) => [
      segment.id,
      availableSeconds(ordered, index, {
        borrowSeconds: config.alignment.borrow_silence_ms / 1000,
        gapSeconds: config.alignment.gap_ms / 1000,
      }),
    ]),
  );
  const overlong = pending.filter(
    (segment) =>
      segment.tts_duration !== null &&
      segment.tts_duration > (roomOf.get(segment.id) ?? slotOf(segment)) * config.alignment.max_tempo,
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

  const measured = measureSpeechRate(pending);
  const measuredCps = measured?.charsPerSecond ?? null;
  if (measured !== null && measuredCps !== null) {
    // Later stages size their targets from the real rate of this voice rather
    // than the configured guess (SPEC FR-5).
    await rememberCalibration(workspace, {
      chars_per_second: measuredCps,
      overhead_seconds: measured.overheadSeconds,
      voice: config.tts.default_voice,
      measured_at: new Date().toISOString(),
      samples: pending.length,
    });
    const configured = config.translate.chars_per_second;
    // Сравнивать надо с тем, чем стадия перевода пользовалась на самом деле:
    // замер применяется сам, и советовать «уточните настройку» бессмысленно.
    const used = (await effectiveSpeechShape(workspace, config)).charsPerSecond;
    const drift = Math.abs(measuredCps - used) / used;
    log.step(
      `фактический темп речи: ${measuredCps} симв/с плюс ${measured.overheadSeconds} с на реплику ` +
        `(перевод целился в ${used}, в настройках ${configured})`,
    );
    if (drift > 0.12) {
      warnings.push(
        `Фактический темп синтеза ${measuredCps} симв/с отличается от того, в который целился перевод ` +
          `(${used}). Замер запомнен — следующий прогон этого голоса попадёт точнее`,
      );
    }
  }

  await workspace.writeSegments(segments);
  return { segments, provider: provider.name, warnings, measuredCps };
}
