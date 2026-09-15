import type { WordTiming } from '../core/types.js';
import { readClip, writeClip } from '../util/wav.js';

/**
 * Куда девать время, которого перевод не занял.
 *
 * Русская реплика часто короче своего слота, и до сих пор выбор был из двух
 * плохих: дописать текст — слышно как фальшь («Лиза.» → «Лиза, Лиза») — или
 * оставить дыру тишины в конце, под ещё шевелящимися губами. Живой укладчик
 * делает третье: раскладывает недостающее время по паузам внутри фразы, где
 * оригинал и сам молчит.
 *
 * Данные для этого есть: whisper отдаёт тайминги слов оригинала, и по ним видно,
 * где говорящий делал вдох. Тишина внутри синтезированного клипа ищется тут же,
 * по громкости. ТЗ это не нарушает: FR-6.1 требует добить реплику тишиной до
 * конца слота — здесь та же тишина, просто разложенная по местам, где её не
 * слышно.
 *
 * Так же устроен и «prosodic alignment» в работах по автоматическому дубляжу
 * (Amazon, arXiv 2204.02530): перевод режется на фразы под паузы оригинала. С
 * одной разницей: там фразы синтезируют по отдельности, и интонация у каждой
 * своя, а здесь тишина добавляется в уже готовый клип — поэтому она кладётся
 * только туда, где синтезатор и сам замолчал, а сплошная речь не разрезается.
 * Резать её ради ритма без пересинтеза нельзя: интонация фразы продолжится
 * через вставленную дыру и выдаст подделку.
 */

export interface Pause {
  /** Секунды от начала клипа или реплики. */
  start: number;
  end: number;
}

export interface FindPauseOptions {
  /** Тише этой доли от громкости клипа — тишина. */
  threshold?: number;
  /**
   * Короче этого паузой не считается.
   *
   * Было 90 мс, и это оказалось разрушительно: на 113 клипах настоящего фильма
   * нашлось 542 промежутка тишины, но пауз длиннее 250 мс — всего 29. Остальное
   * — стыки слов и смычки согласных внутри слова, по 100–150 мс. Растягивая их,
   * стадия резала слова пополам: «О да, [пауза] те…перь ты [пауза] мой» вместо
   * «О да, теперь ты мой». Это слышно как съеденные окончания, и именно так
   * пользователь и услышал.
   */
  minSeconds?: number;
  /** Кадр анализа. */
  frameSeconds?: number;
}

/**
 * Тишина внутри клипа. Края не в счёт: тишина в начале сдвинула бы реплику с
 * её таймкода, а в конце она и так остаётся.
 */
export function findPauses(samples: Float32Array, sampleRate: number, options: FindPauseOptions = {}): Pause[] {
  const frame = Math.max(1, Math.round((options.frameSeconds ?? 0.02) * sampleRate));
  const minSeconds = options.minSeconds ?? 0.25;
  const threshold = options.threshold ?? 0.06;

  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak === 0) return [];
  const floor = peak * threshold;

  const quiet: boolean[] = [];
  for (let offset = 0; offset + frame <= samples.length; offset += frame) {
    let sum = 0;
    for (let i = offset; i < offset + frame; i++) sum += samples[i]! * samples[i]!;
    quiet.push(Math.sqrt(sum / frame) < floor);
  }

  const pauses: Pause[] = [];
  let run = -1;
  for (const [index, isQuiet] of quiet.entries()) {
    if (isQuiet && run < 0) run = index;
    if (!isQuiet && run >= 0) {
      pauses.push({ start: (run * frame) / sampleRate, end: (index * frame) / sampleRate });
      run = -1;
    }
  }
  // Незакрытый прогон — это хвост клипа, а не пауза внутри него.

  const first = quiet.indexOf(false);
  const last = quiet.lastIndexOf(false);
  if (first < 0) return [];
  const speechFrom = (first * frame) / sampleRate;
  const speechTo = ((last + 1) * frame) / sampleRate;
  return pauses.filter((pause) => pause.end - pause.start >= minSeconds && pause.start > speechFrom && pause.end < speechTo);
}

/**
 * Паузы внутри оригинальной реплики — по таймингам слов.
 *
 * Порог в 300 мс взят не с потолка: столько же считают паузой работы по
 * автоматическому дубляжу, на которые опирается вся эта затея — Amazon
 * «Prosodic alignment for off-screen automatic dubbing» (arXiv 2204.02530) и
 * «Jointly Optimizing Translations and Speech Timing» (arXiv 2302.12979).
 * Короче — это стык слов, а не вдох, и растягивать его не надо.
 *
 * Именно внутри реплики: whisper уже режет её по молчанию, поэтому таких пауз
 * немного, но вдох между «Ты убил троих» и «...наших людей» виден.
 */
export function originalPauses(words: WordTiming[] | null, minSeconds = 0.3): Pause[] {
  if (!words || words.length < 2) return [];
  const pauses: Pause[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1]!.start - words[i]!.end;
    if (gap >= minSeconds) pauses.push({ start: words[i]!.end, end: words[i + 1]!.start });
  }
  return pauses;
}

export interface Insertion {
  /** Секунда клипа, в которую вставляется тишина. */
  at: number;
  seconds: number;
}

export interface SpreadOptions {
  /** Сколько можно добавить в одну паузу: длиннее — это уже обрыв реплики. */
  maxPerPause?: number;
  /** Мельче этого не возимся: на слух разницы нет. */
  minInsertion?: number;
  /**
   * Сколько тишины реплика способна вынести всего.
   *
   * Реплика на 1.3 секунды получила полторы секунды пауз — больше, чем в ней
   * самой речи, — и распалась на куски. Доля от собственной длительности держит
   * добавку соразмерной: короткая реплика получает немного, длинная больше.
   */
  maxTotal?: number;
  /** Больше этого числа пауз в одной реплике не трогаем. */
  maxPauses?: number;
}

/**
 * Как разложить недостающее время по паузам клипа.
 *
 * Вес паузы — её длина в оригинале, если пауз там столько же: значит говорящий
 * молчал в этом месте, и туда же уходит время. Если оригинал молчал иначе —
 * поровну. Остаток, который не уместился, остаётся в конце, как и раньше.
 */
export function spreadPlan(
  clipPauses: Pause[],
  original: Pause[],
  slackSeconds: number,
  options: SpreadOptions = {},
): Insertion[] {
  const maxPerPause = options.maxPerPause ?? 0.4;
  const minInsertion = options.minInsertion ?? 0.08;
  const maxPauses = options.maxPauses ?? 2;
  const slack = Math.min(slackSeconds, options.maxTotal ?? slackSeconds);
  if (slack <= minInsertion || clipPauses.length === 0) return [];

  // Самые длинные паузы — самые настоящие: их и растягиваем, остальные не трогаем.
  const chosen = [...clipPauses].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, maxPauses).sort((a, b) => a.start - b.start);
  const weights =
    original.length === chosen.length && original.length > 0
      ? original.map((pause) => pause.end - pause.start)
      : chosen.map(() => 1);
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];

  const insertions: Insertion[] = [];
  let left = slack;
  for (const [index, pause] of chosen.entries()) {
    if (left <= minInsertion) break;
    const share = Math.min(maxPerPause, (slack * weights[index]!) / total, left);
    if (share < minInsertion) continue;
    // Вставляем в середину паузы: на стыке со словом щелчка не будет.
    insertions.push({ at: Number(((pause.start + pause.end) / 2).toFixed(3)), seconds: Number(share.toFixed(3)) });
    left -= share;
  }
  return insertions;
}

/** Клип с разложенной по нему тишиной. Порядок вставок значения не имеет. */
export function insertSilence(samples: Float32Array, sampleRate: number, insertions: Insertion[]): Float32Array {
  if (insertions.length === 0) return samples;
  const ordered = [...insertions].sort((a, b) => a.at - b.at);
  const extra = ordered.reduce((sum, item) => sum + Math.round(item.seconds * sampleRate), 0);
  const out = new Float32Array(samples.length + extra);

  let read = 0;
  let write = 0;
  for (const item of ordered) {
    const cut = Math.min(samples.length, Math.max(read, Math.round(item.at * sampleRate)));
    out.set(samples.subarray(read, cut), write);
    write += cut - read;
    read = cut;
    write += Math.round(item.seconds * sampleRate); // тишина — нули, уже на месте
  }
  out.set(samples.subarray(read), write);
  return out;
}

export interface SpreadResult {
  /** Сколько секунд разложено по паузам; 0 — раскладывать было нечего. */
  added: number;
  pauses: number;
}

/**
 * Раскладывает недостающее время по паузам готового клипа, переписывая его.
 *
 * Возвращает ноль, если пауз внутри нет: тогда тишина остаётся в конце, как и
 * требует ТЗ. Файл в этом случае не трогается вовсе.
 */
export async function spreadPausesInClip(
  filePath: string,
  slackSeconds: number,
  words: WordTiming[] | null,
  options: SpreadOptions = {},
): Promise<SpreadResult> {
  const { samples, sampleRate } = await readClip(filePath);
  /*
   * Больше трети собственной длительности реплика не получает.
   *
   * Иначе короткая фраза тонет в паузах: «О да, теперь ты мой» — 1.3 секунды
   * речи — получила полторы секунды тишины и распалась на куски.
   */
  const speech = samples.length / sampleRate;
  const plan = spreadPlan(findPauses(samples, sampleRate), originalPauses(words), slackSeconds, {
    maxTotal: speech * 0.35,
    ...options,
  });
  if (plan.length === 0) return { added: 0, pauses: 0 };
  await writeClip(filePath, insertSilence(samples, sampleRate, plan), sampleRate);
  return { added: Number(plan.reduce((sum, item) => sum + item.seconds, 0).toFixed(3)), pauses: plan.length };
}
