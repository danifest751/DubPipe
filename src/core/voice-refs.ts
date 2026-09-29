import type { Segment } from './types.js';

/**
 * Образцы голосов актёров для клонирования.
 *
 * Модель клонирования слышит голос по короткому образцу и тексту к нему, и
 * качество упирается в то, насколько они совпадают. Правила выведены из пробы
 * на восьмом эпизоде: реплика «Oh, my God.», растянутая на 3.2 с, давала модели
 * три слова на три секунды звука — и в начале озвученных фраз проскакивали
 * лишние звуки. Поэтому образец — одна реплика этого персонажа, где:
 *
 * - больше никто не говорит (по диаризации, а не по одной её разметке);
 * - речь плотная: знаков в секунду примерно столько, сколько обычно в этом языке;
 * - длина около пяти секунд: короче — модели мало голоса, длиннее — каждая
 *   реплика озвучивается дольше, потому что образец обрабатывается с каждой.
 */

export interface DiarizationTurnLike {
  start: number;
  end: number;
  speaker: string;
}

export interface ReferenceCandidate {
  id: number;
  start: number;
  end: number;
  seconds: number;
  text: string;
  /** Знаков оригинала в секунду: по нему видно, нет ли внутри долгой паузы. */
  rate: number;
  /** Подходит ли по всем правилам, а не только как запасной вариант. */
  good: boolean;
  /**
   * Где резать звук, если края реплики найдены по паузам в дорожке, а не взяты
   * из распознавания; см. `referenceEdges`.
   */
  cut?: ReferenceCut;
}

export interface ReferenceCut {
  start: number;
  end: number;
  /** Нашлась ли пауза и в начале — без неё в образец попадает обрывок чужого слова. */
  cleanStart: boolean;
}

/** Длина кадра, по которому меряется громкость на краях образца, секунд. */
export const EDGE_FRAME_SECONDS = 0.02;
/** Тишина короче этой — просто глухой звук внутри слова, а не пауза, секунд. */
const EDGE_PAUSE_SECONDS = 0.15;
/** Насколько тише речи должна быть пауза, дБ. */
const EDGE_QUIET_DB = 18;
/** Как далеко за отметку распознавания искать паузу, секунд. */
export const EDGE_SEARCH_SECONDS = 1.2;

export interface EdgeBounds {
  /** Конец предыдущей реплики — кого угодно; раньше него не искать. */
  previousEnd: number | null;
  /** Начало следующей реплики — кого угодно; пауза должна быть до неё. */
  nextStart: number | null;
}

/**
 * Края образца по паузам в дорожке голоса.
 *
 * Отметки распознавания на краях реплики неточны на десятые доли секунды: на
 * ролике FRANCE 24 «conversation» по ним кончалось на 228.06 с, а звучало до
 * 228.56. Образец, обрезанный на «conver-», модель клонирования договаривала в
 * начале каждой новой реплики — «сейшн, с правительством…», а «may-» от
 * «maybe» — как «би». Поэтому конец образца режется по настоящей паузе: первой
 * после конца реплики.
 *
 * `levels` — громкость кадров по `EDGE_FRAME_SECONDS`, дБ, с `windowStart`.
 * `null` — паузы в конце нет: речь идёт встык со следующей репликой, и чистого
 * образца из этой реплики не снять.
 */
export function referenceEdges(
  levels: number[],
  windowStart: number,
  line: { start: number; end: number },
  bounds: EdgeBounds,
): ReferenceCut | null {
  const frame = EDGE_FRAME_SECONDS;
  const at = (seconds: number): number => Math.round((seconds - windowStart) / frame);
  const inside = levels.slice(Math.max(0, at(line.start)), Math.max(0, at(line.end))).sort((a, b) => a - b);
  if (inside.length === 0) return null;
  const speech = inside[Math.floor(inside.length * 0.9)]!;
  const quiet = (index: number): boolean => index < 0 || index >= levels.length || levels[index]! < speech - EDGE_QUIET_DB;
  const need = Math.round(EDGE_PAUSE_SECONDS / frame);

  // Конец: первая пауза, начавшаяся не раньше чем чуть до отметки.
  let end: number | null = null;
  for (let index = Math.max(0, at(line.end - EDGE_PAUSE_SECONDS)); index < levels.length; index++) {
    let run = 0;
    while (run < need && quiet(index + run)) run++;
    if (run >= need) {
      end = windowStart + index * frame;
      break;
    }
  }
  if (end === null || (bounds.nextStart !== null && end > bounds.nextStart + 0.1)) return null;

  // Начало: последняя пауза, кончившаяся не позже чем чуть после отметки.
  let start: number | null = null;
  for (let index = Math.min(levels.length, at(line.start + EDGE_PAUSE_SECONDS)); index >= 0; index--) {
    let run = 0;
    while (run < need && quiet(index - 1 - run)) run++;
    if (run >= need) {
      start = windowStart + index * frame;
      break;
    }
  }
  /*
   * Без паузы в начале образец всё равно годен: обрывок в начале модель не
   * договаривает — договаривает она только конец. Режем по самому тихому месту
   * рядом с отметкой, не залезая в предыдущую реплику.
   */
  const cleanStart = start !== null && (bounds.previousEnd === null || start >= bounds.previousEnd - 0.1);
  if (!cleanStart || start === null) {
    const from = Math.max(0, at(Math.max(line.start - 0.3, (bounds.previousEnd ?? -Infinity) - 0.05)));
    const to = Math.min(levels.length - 1, at(line.start + 0.1));
    let quietest = Math.min(from, to);
    for (let index = from; index <= to; index++) if (levels[index]! < levels[quietest]!) quietest = index;
    start = windowStart + quietest * frame;
  }
  if (end - start < 1) return null;

  // Немного тишины по краям: модель срежет её сама, а конец слова уцелеет.
  return {
    start: Number(Math.max(windowStart, start - 0.05).toFixed(3)),
    end: Number((end + 0.08).toFixed(3)),
    cleanStart,
  };
}

/** Длина, к которой стремится образец, секунд. */
export const IDEAL_REFERENCE_SECONDS = 5;

export interface ReferenceOptions {
  /** Обычная скорость текста в языке оригинала, знаков в секунду. */
  charsPerSecond: number;
}

/** Реплики, из которых можно снять образец голоса, — лучшие первыми. */
export function referenceCandidates(
  segments: Segment[],
  turns: DiarizationTurnLike[],
  speaker: string,
  options: ReferenceOptions,
): ReferenceCandidate[] {
  const alone = (segment: Segment): boolean =>
    new Set(turns.filter((turn) => turn.end > segment.start && turn.start < segment.end).map((turn) => turn.speaker)).size <= 1;
  const low = options.charsPerSecond * 0.5;
  const high = options.charsPerSecond * 1.2;

  return segments
    .filter(
      (segment) =>
        segment.speaker === speaker &&
        !segment.overlap &&
        !segment.flags.includes('speaker_doubt') &&
        segment.text_en.trim().length > 8 &&
        segment.end - segment.start >= 1.5 &&
        segment.end - segment.start <= 10 &&
        alone(segment),
    )
    .map((segment) => {
      const seconds = segment.end - segment.start;
      const text = segment.text_en.trim();
      // С пробелами — так же, как считается скорость субтитров в профиле языка.
      const rate = text.length / seconds;
      return {
        id: segment.id,
        start: segment.start,
        end: segment.end,
        seconds: Number(seconds.toFixed(2)),
        text,
        rate: Number(rate.toFixed(1)),
        good: seconds >= 3 && seconds <= 8 && rate >= low && rate <= high,
      };
    })
    .sort(
      (a, b) =>
        Number(b.good) - Number(a.good) ||
        Math.abs(a.seconds - IDEAL_REFERENCE_SECONDS) - Math.abs(b.seconds - IDEAL_REFERENCE_SECONDS),
    );
}

/**
 * Образец для персонажа: выбранный человеком, иначе лучший из кандидатов.
 * `null` — клонировать нечем или человек клонирование для персонажа выключил.
 */
export function pickReference(
  segments: Segment[],
  turns: DiarizationTurnLike[],
  speaker: string,
  options: ReferenceOptions,
  chosen?: number | 'off',
): ReferenceCandidate | null {
  if (chosen === 'off') return null;
  const candidates = referenceCandidates(segments, turns, speaker, options);
  if (typeof chosen === 'number') {
    // Выбранная человеком реплика годится, даже если правилам она не нравится:
    // он её слышал, а правила — нет. Лишь бы это была реплика этого персонажа.
    const own = segments.find((segment) => segment.id === chosen && segment.speaker === speaker);
    if (own) {
      const seconds = own.end - own.start;
      return {
        id: own.id,
        start: own.start,
        end: own.end,
        seconds: Number(seconds.toFixed(2)),
        text: own.text_en.trim(),
        rate: Number((own.text_en.trim().length / seconds).toFixed(1)),
        good: true,
      };
    }
  }
  return candidates[0] ?? null;
}
