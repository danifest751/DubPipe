import path from 'node:path';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { DubConfig } from '../config/schema.js';
import { cancellation } from '../core/cancel.js';
import { counter, log } from '../core/logger.js';
import { slotOf, warn, type Segment, type StageWarning } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import { applyOverrides, withKnownVoices } from '../core/overrides.js';
import { createTtsProvider, voiceForSpeaker, type TtsProvider } from '../providers/tts/index.js';
import { effectiveSpeechShape, rememberCalibration } from '../core/calibration.js';
import { roomFor } from './s3-translate.js';
import { sha256 } from '../util/hash.js';
import { readClip, writeClip } from '../util/wav.js';
import { sourcePhrases, speakable, splitTranslation, type PhrasePlan } from './s5-phrases.js';

/**
 * S5 — speech synthesis, one clip per replica (SPEC FR-5).
 * Produces: tts/NNNN.wav, plus tts_file and tts_duration on every segment.
 */

export interface S5Result {
  segments: Segment[];
  provider: string;
  warnings: StageWarning[];
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
  const overrides = await workspace.readOverrides();
  const speakers = await workspace.readSpeakers();
  const provider = createTtsProvider(workspace, baseConfig);
  const stale: StageWarning[] = [];
  try {
    // Имена голосов от прежнего движка отбрасываются, а не роняют стадию:
    // отбор общий с укладкой, она переозвучивает сокращённые реплики.
    const known = new Set(await provider.listVoices().catch(() => []));
    const pruned = withKnownVoices(baseConfig, overrides, known);
    for (const gone of pruned.dropped) {
      stale.push(
        warn('warn.s5.foreignVoice', `Голос «${gone.voice}» (${gone.speaker}, ${gone.source}) этому движку неизвестен — выбран по полу`, {
          voice: gone.voice,
          speaker: gone.speaker,
          source: gone.source,
        }),
      );
    }
    const config = applyOverrides(pruned.config, pruned.overrides, speakers);
    const result = await synthesizeAll(workspace, config, segments, provider);
    return { ...result, warnings: [...stale, ...result.warnings] };
  } finally {
    // Движок мог держать поднятую модель в отдельном процессе. Отпускаем и на
    // ошибке тоже: иначе процесс переживёт стадию и удержит программу.
    provider.close?.();
  }
}

/**
 * Синтез реплики по фразам оригинала.
 *
 * Говорящий делал паузы — дубляж делает их там же: перевод режется на столько
 * же кусков, каждый озвучивается отдельно и клипы склеиваются через паузы
 * оригинала. Так реплика молчит вместе с актёром, а не выговаривает всё подряд,
 * оставляя дыру в конце. Это «prosodic alignment» из работ по автоматическому
 * дубляжу (Amazon, arXiv 2204.02530); порог в 300 мс, по которому молчание
 * считается паузой, оттуда же.
 *
 * Куски озвучиваются порознь не ради удобства: у отдельной фразы своя интонация
 * с завершением, а разрезать готовый сплошной клип нельзя — интонация потянется
 * через вставленную тишину и выдаст подделку.
 */
async function synthesizePhrases(
  provider: TtsProvider,
  segment: Segment,
  plan: PhrasePlan,
  voice: string,
  outputPath: string,
): Promise<{ path: string; durationSeconds: number; rhythm: boolean }> {
  const parts: string[] = [];
  try {
    const clips: Array<{ samples: Float32Array; sampleRate: number }> = [];
    for (const [index, text] of plan.parts.entries()) {
      const partPath = `${outputPath}.part${index}.wav`;
      parts.push(partPath);
      await provider.synthesize({ id: segment.id, text, voice, outputPath: partPath });
      clips.push(await readClip(partPath));
    }

    const sampleRate = clips[0]!.sampleRate;
    /*
     * Паузы кладутся только в то время, которое реплике и так не нужно.
     *
     * Первая версия вставляла паузы оригинала как есть — и реплика, которая
     * едва помещалась, вылезала за слот: «Вы совершаете очень серьёзную ошибку»
     * из 1.66 с превращалась в 3.23 с, и укладке оставалось её ускорять. Ритм
     * оригинала стоит того, чтобы его повторить, но не ценой ускорения всей
     * реплики. Свободного времени нет — куски просто склеиваются встык.
     */
    const speech = clips.reduce((sum, clip) => sum + clip.samples.length / sampleRate, 0);
    const budget = Math.max(0, slotOf(segment) - speech);
    const asked = plan.pauses.reduce((sum, value) => sum + value, 0);
    const scale = asked > 0 ? Math.min(1, budget / asked) : 0;
    /*
     * Свободного времени нет — реплика озвучивается целиком, как раньше.
     *
     * Дробить её тогда не за чем: паузы всё равно нулевые, а склейка отдельно
     * озвученных кусков звучит иначе, чем одна фраза, — у каждого куска своё
     * интонационное завершение. Менять звучание без выигрыша нельзя.
     */
    if (scale * asked < 0.08) {
      const whole = await provider.synthesize({ id: segment.id, text: plan.parts.join(' '), voice, outputPath });
      return { ...whole, rhythm: false };
    }
    const silences = plan.pauses.map((seconds) => Math.round(seconds * scale * sampleRate));
    const total = clips.reduce((sum, clip) => sum + clip.samples.length, 0) + silences.reduce((sum, value) => sum + value, 0);
    const joined = new Float32Array(total);
    let offset = 0;
    for (const [index, clip] of clips.entries()) {
      joined.set(clip.samples, offset);
      offset += clip.samples.length + (silences[index] ?? 0);
    }
    await writeClip(outputPath, joined, sampleRate);
    return { path: outputPath, durationSeconds: joined.length / sampleRate, rhythm: true };
  } finally {
    for (const part of parts) await rm(part, { force: true });
  }
}

async function synthesizeAll(
  workspace: Workspace,
  config: DubConfig,
  segments: Segment[],
  provider: TtsProvider,
): Promise<S5Result> {
  const warnings: StageWarning[] = [];
  const outputDir = await workspace.subdir('tts');

  const written = segments.filter((segment) => segment.text_ru && segment.text_ru.trim().length > 0);
  /*
   * Реплика, в которой синтезатору нечего произнести, синтез не останавливает.
   *
   * Русский движок латиницу выбрасывает молча, а на реплике из одной латиницы
   * отвечает отказом — и этот отказ валил стадию целиком: фильм не озвучивался
   * из-за одной строки. Теперь строка остаётся без клипа, как всякая
   * непереведённая, и о ней сказано человеку.
   */
  const mute = written.filter((segment) => !speakable(segment.text_ru!));
  if (mute.length > 0) {
    const first = mute[0]!;
    warnings.push(
      warn(
        'warn.s5.nothingToSay',
        `${mute.length} реплик не озвучены: в переводе нет русских букв (первая — ${first.id}: «${first.text_ru!.slice(0, 40)}»)`,
        { count: mute.length, id: first.id, text: first.text_ru!.slice(0, 40) },
      ),
    );
  }
  const pending = written.filter((segment) => speakable(segment.text_ru!));
  if (pending.length === 0) {
    return { segments, provider: provider.name, warnings: ['Нет переведённых реплик для синтеза'], measuredCps: null };
  }

  const voices = new Set<string>();
  for (const segment of pending) {
    voices.add(voiceForSpeaker(segment.speaker, config.tts.voice_map, config.tts.default_voice));
  }
  log.step(`синтез ${pending.length} реплик, голосов: ${[...voices].join(', ')}`);

  /*
   * Темп речи нужен, чтобы заранее понять, влезет ли реплика с паузами.
   *
   * Без этой прикидки стадия сначала озвучивала реплику по кускам, обнаруживала,
   * что свободного времени нет, и озвучивала её заново целиком — двойная работа
   * ради нуля. На двух эпизодах ни одна реплика с паузами говорящего так и не
   * получила свободного времени: пауза внутри бывает там, где сказано много, а
   * такую реплику русский перевод заполняет с запасом.
   */
  const shape = await effectiveSpeechShape(workspace, config);

  let done = 0;
  let byRhythm = 0;
  await withConcurrency(pending, config.tts.concurrency, async (segment) => {
    const outputPath = path.join(outputDir, `${String(segment.id).padStart(4, '0')}.wav`);
    const voice = voiceForSpeaker(segment.speaker, config.tts.voice_map, config.tts.default_voice);

    // Повторный запуск не переозвучивает то, что уже озвучено тем же движком,
    // голосом и текстом. Проверять только наличие файла нельзя: смена голоса
    // тогда не меняет ничего, файлы-то на месте.
    /*
     * Если говорящий делал паузы, реплика озвучивается по фразам и собирается с
     * теми же паузами. План входит в отпечаток: без этого повторный прогон
     * оставил бы клип, склеенный по-старому.
     */
    const predicted = segment.text_ru!.length / shape.charsPerSecond + shape.overheadSeconds;
    /*
     * Разметку фраз даёт S3, спросив у модели: она видит, где фраза делится, а
     * знаков препинания там может не быть вовсе («С этого момента клан Сиртр
     * переходит под власть Варака»). Своё деление по знакам остаётся запасным —
     * на случай, когда разметки нет: модель не ответила или реплику правили руками.
     */
    const phrases = sourcePhrases(segment.words);
    const marked = segment.phrases && segment.phrases.length > 1 ? segment.phrases : null;
    const plan =
      config.tts.phrase_rhythm && predicted < slotOf(segment) - 0.08 && phrases.length >= 2
        ? marked
          ? { parts: marked, pauses: phrases.slice(0, marked.length - 1).map((phrase) => phrase.pauseAfter) }
          : splitTranslation(segment.text_ru!, phrases)
        : null;
    const key = ttsKey(voice, segment.text_ru!, provider.fingerprint + (plan ? `|фразы:${plan.parts.length}:${plan.pauses.join(',')}` : ''));
    if (
      existsSync(outputPath) &&
      segment.tts_file === outputPath &&
      segment.tts_duration !== null &&
      segment.tts_key === key
    ) {
      done++;
      return;
    }

    const result = plan
      ? await synthesizePhrases(provider, segment, plan, voice, outputPath)
      : await provider.synthesize({ id: segment.id, text: segment.text_ru!, voice, outputPath });
    recordClip(segment, result, voice, segment.text_ru!, provider.fingerprint + (plan ? `|фразы:${plan.parts.length}:${plan.pauses.join(',')}` : ''));
    if (plan && 'rhythm' in result && result.rhythm) byRhythm++;

    done++;
    log.progress(`синтезировано реплик ${counter(done, pending.length)}`, null, { done, total: pending.length }, { key: 'work.tts', params: { done, total: pending.length } });
    if (done % 10 === 0 || done === pending.length) log.step(`синтезировано ${counter(done, pending.length)}`);
  });

  if (byRhythm > 0) log.step(`озвучено по фразам оригинала: ${byRhythm}`);

  // Место считается так же, как его считают перевод и укладка: слот плюс
  // занимаемая пауза. По голому слоту предупреждение пугало впустую — на
  // редком на диалог материале оно насчитывало 39% там, где укладка не
  // сократила ни одной реплики.
  const roomOf = roomFor(config, segments);
  const overlong = pending.filter(
    (segment) => segment.tts_duration !== null && segment.tts_duration > roomOf(segment) * config.alignment.max_tempo,
  );
  if (overlong.length > 0) {
    const share = ((overlong.length / pending.length) * 100).toFixed(0);
    const tail = config.alignment.enabled
      ? 'стадия S6 сократит их через LLM'
      : 'стадия S6 отключена, реплики будут наезжать друг на друга';
    warnings.push(
      warn(
        config.alignment.enabled ? 'warn.s5.overlong' : 'warn.s5.overlongNoAlign',
        `${overlong.length} реплик (${share}%) не укладываются в слот даже при максимальном темпе — ${tail}`,
        { count: overlong.length, share },
      ),
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
        warn(
          'warn.s5.rate',
          `Фактический темп синтеза ${measuredCps} симв/с отличается от того, в который целился перевод ` +
            `(${used}). Замер запомнен — следующий прогон этого голоса попадёт точнее`,
          { measured: measuredCps, used },
        ),
      );
    }
  }

  await workspace.writeSegments(segments);
  return { segments, provider: provider.name, warnings, measuredCps };
}
