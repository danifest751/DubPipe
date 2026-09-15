import type { WordTiming } from '../core/types.js';

/**
 * Разбиение перевода на фразы по ритму оригинала — «prosodic alignment».
 *
 * Задача известная, и решают её так: реплику оригинала режут по паузам на
 * фразы, перевод делят на столько же кусков, каждый озвучивают отдельно и
 * складывают обратно с теми же паузами. Тогда дубляж молчит там же, где молчал
 * актёр, а не выговаривает всё подряд, оставляя дыру в конце.
 *
 * Работы, на которые это опирается: Amazon, «Prosodic alignment for off-screen
 * automatic dubbing» (arXiv 2204.02530) и «Jointly Optimizing Translations and
 * Speech Timing» (arXiv 2302.12979). Оттуда же порог в 300 мс: молчание короче
 * — это стык слов, а не пауза.
 *
 * Их оценка разбиения складывается из четырёх слагаемых, и первое — языковая
 * модель на месте разреза: она и разрешает резать где угодно. Здесь её нет, и
 * попытка резать по длине сразу показала, чем это кончается: «С этого момента
 * клан | Сиртр | переходит» — разрез посреди именной группы. Поэтому режем
 * только по знакам препинания, а какой знак какой паузе достанется, решает
 * время: пауза из середины реплики ищет знак в середине перевода.
 *
 * Знаков не хватило на все паузы — берём сколько есть; не нашлось ни одного —
 * не делим, и реплика озвучивается целиком, как раньше.
 */

export interface SourcePhrase {
  /** Границы фразы в оригинале, секунды от начала записи. */
  start: number;
  end: number;
  /** Пауза перед следующей фразой; у последней — 0. */
  pauseAfter: number;
}

/**
 * Фразы оригинала: слова, разделённые молчанием длиннее порога.
 *
 * Пустой список — говорящий не делал пауз, и делить перевод не нужно: у реплики
 * один кусок, и она синтезируется как раньше.
 */
export function sourcePhrases(words: WordTiming[] | null, minPause = 0.3): SourcePhrase[] {
  if (!words || words.length < 2) return [];
  const phrases: SourcePhrase[] = [];
  let from = words[0]!.start;
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1]!.start - words[i]!.end;
    if (gap < minPause) continue;
    phrases.push({ start: from, end: words[i]!.end, pauseAfter: Number(gap.toFixed(3)) });
    from = words[i + 1]!.start;
  }
  if (phrases.length === 0) return [];
  phrases.push({ start: from, end: words[words.length - 1]!.end, pauseAfter: 0 });
  return phrases;
}

/** Знаки препинания, после которых русская фраза делится без насилия. */
const BREAKS = new Set(['.', '!', '?', '…', ';', ':', '—', '–', ',']);

export interface PhrasePlan {
  /** Куски перевода: не больше, чем фраз в оригинале. */
  parts: string[];
  /** Паузы между кусками, секунды — взяты у оригинала. */
  pauses: number[];
}

export interface SplitOptions {
  /** Короче этого кусок не фраза, а огрызок. */
  minChars?: number;
}

/** Места, где текст можно разрезать: сразу после знака препинания. */
export function breakPoints(text: string): number[] {
  const points: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (!BREAKS.has(text[i]!)) continue;
    if (text[i + 1] !== ' ') continue;
    points.push(i + 1);
  }
  return points;
}

/**
 * Делит перевод по ритму оригинала — но только по знакам препинания.
 *
 * В статье место разреза выбирает языковая модель, и потому там можно резать
 * где угодно. Здесь её нет, и попытка резать «где придётся» сразу это показала:
 * «С этого момента клан | Сиртр | переходит» — разрез посреди именной группы,
 * который слышно как заикание. Знак препинания — единственное место, где
 * русская фраза делится заведомо без насилия. Не хватило знаков на все паузы
 * оригинала — берём столько кусков, сколько получается; не нашлось ни одного —
 * не делим вовсе, и реплика озвучивается как раньше.
 *
 * Какие именно знаки взять, решает время: пауза оригинала, пришедшаяся на
 * середину реплики, ищет себе знак в середине перевода.
 */
export function splitTranslation(text: string, phrases: SourcePhrase[], options: SplitOptions = {}): PhrasePlan | null {
  const minChars = options.minChars ?? 4;
  const clean = text.trim();
  if (phrases.length < 2 || clean.length === 0) return null;

  const points = breakPoints(clean).filter((point) => point >= minChars && clean.length - point >= minChars);
  if (points.length === 0) return null;

  // Доля реплики, на которую приходится каждая пауза оригинала.
  const from = phrases[0]!.start;
  const span = phrases[phrases.length - 1]!.end - from;
  if (span <= 0) return null;
  const wanted = phrases.slice(0, -1).map((phrase, index) => ({
    share: (phrase.end - from) / span,
    pause: phrases[index]!.pauseAfter,
  }));

  // Каждой паузе — свой знак, по близости доли; один знак дважды не берём.
  const taken = new Map<number, number>();
  for (const { share, pause } of wanted) {
    const free = points.filter((point) => !taken.has(point));
    if (free.length === 0) break;
    const best = free.reduce((a, b) => (Math.abs(a / clean.length - share) <= Math.abs(b / clean.length - share) ? a : b));
    taken.set(best, pause);
  }
  if (taken.size === 0) return null;

  const cuts = [...taken.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  let at = 0;
  for (const cut of [...cuts, clean.length]) {
    parts.push(clean.slice(at, cut).trim());
    at = cut;
  }
  if (parts.some((part) => part.length < minChars)) return null;

  return { parts, pauses: cuts.map((cut) => taken.get(cut)!) };
}
