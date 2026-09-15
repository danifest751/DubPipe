import type { VoiceGender } from '../providers/diarization/gender.js';
import type { Segment } from './types.js';

/**
 * Пол говорящего по русскому тексту перевода — вторая улика рядом с тоном.
 *
 * Тон голоса на реальном звуке голодает: YIN признаёт устойчивыми 9% кадров, и
 * вердикт о поле часто выходит «не знаю» (171 Гц — ровно середина полосы, где
 * определитель молчит) либо опирается на полсекунды речи. А русский текст род
 * называет прямо: «я пришёл», «ты сказала».
 *
 * Улика честная, не круговая: переводчику пол говорящего не сообщают — в запрос
 * уходят только номер, слот и оригинал, — значит род выбран из смысла сцены,
 * а не переписан из нашего же замера.
 *
 * Улик две, и они разной прочности. Первое лицо говорит о том, кто произносит
 * реплику, — гадать не о чем. Обращение говорит о собеседнике, а кто собеседник,
 * конвейер знает не всегда: засчитываем, только если в реплике названо имя
 * подписанного персонажа либо в сцене ровно один второй голос.
 */

/** Краткие прилагательные и местоимения, у которых род виден без глагола. */
const SHORT_MALE = new Set(['должен', 'рад', 'готов', 'уверен', 'сам', 'один', 'виноват', 'прав', 'обязан', 'согласен', 'вынужден']);
const SHORT_FEMALE = new Set(['должна', 'рада', 'готова', 'уверена', 'сама', 'одна', 'виновата', 'права', 'обязана', 'согласна', 'вынуждена']);

/**
 * Существительные, которые кончаются как глагол прошедшего времени.
 *
 * Список короткий намеренно: слово смотрится только сразу за «я» или «ты», и
 * «я стол» в дубляже не встречается. Но «ты — скала» встречается, а «зал»,
 * «угол» и «посол» могут оказаться за местоимением в перечислении. Полного
 * словаря здесь не нужно: одиночную ошибку гасит требование двух согласных улик.
 */
const NOT_VERBS = new Set([
  'стол', 'пол', 'зал', 'угол', 'гол', 'мел', 'ствол', 'котёл', 'посол', 'осёл',
  'козёл', 'орёл', 'узел', 'вол', 'мол', 'скала', 'школа', 'сила', 'пила', 'игла',
]);

/**
 * Род слова, если он виден: прошедшее время (`-л`, `-ла`, `-лся`, `-лась`) или
 * краткое прилагательное. `null` — слово о роде ничего не говорит.
 *
 * Длина проверяется, чтобы трёхбуквенные вроде «зал» не считались глаголами;
 * «был» и «мог» при этом нужны, поэтому исключения заданы списком, а не длиной.
 */
export function markWord(word: string): VoiceGender | null {
  const lower = word.toLowerCase();
  if (SHORT_FEMALE.has(lower)) return 'ж';
  if (SHORT_MALE.has(lower)) return 'м';
  if (NOT_VERBS.has(lower)) return null;
  if (lower.length > 3 && (lower.endsWith('лась') || lower.endsWith('ла'))) return 'ж';
  if (lower.length > 2 && (lower.endsWith('лся') || lower.endsWith('л'))) return 'м';
  return null;
}

/** Сколько слов после местоимения ещё считается его сказуемым. */
const WINDOW = 3;

export interface GenderHit {
  gender: VoiceGender;
  /** Кусок текста, по которому вынесен вердикт: человеку видно, на чём он основан. */
  fragment: string;
}

/**
 * Род при местоимении: ближайшее слово с видимым родом в окне после него.
 *
 * Именно ближайшее: в «я знаю, что она пришла» род «пришла» принадлежит ей, а
 * не говорящему, и окно в три слова до неё не дотягивается.
 */
export function hitsFor(text: string, pronoun: string): GenderHit[] {
  const words = text.match(/[а-яёА-ЯЁ]+/g) ?? [];
  const hits: GenderHit[] = [];
  for (const [index, word] of words.entries()) {
    if (word.toLowerCase() !== pronoun) continue;
    for (const next of words.slice(index + 1, index + 1 + WINDOW)) {
      const gender = markWord(next);
      if (gender) {
        hits.push({ gender, fragment: `${word} ${next}` });
        break;
      }
    }
  }
  return hits;
}

/** Улики о самом говорящем: «я пришёл», «я должна». */
export function selfHits(text: string): GenderHit[] {
  return hitsFor(text, 'я');
}

/** Улики о собеседнике: «ты убил», «ты сказала». «Вы» рода не показывает. */
export function addressHits(text: string): GenderHit[] {
  return hitsFor(text, 'ты');
}

/**
 * Имена в звательной позиции: «Будь осторожен, Юкай». По ним собеседник
 * опознаётся точно — но только если зритель уже подписал персонажей.
 */
export function vocativeNames(text: string): string[] {
  return [...text.matchAll(/[,—-]\s*([А-ЯЁ][а-яё]{2,})/g)].map((match) => match[1]!);
}

export interface TextGender {
  /** Вердикт по тексту; `—` — улик не хватило или они спорят между собой. */
  gender: VoiceGender;
  /** Сколько улик «о себе» и сколько обращений легло в вердикт. */
  self: number;
  address: number;
  /** На чём основано — первые несколько кусков текста. */
  examples: string[];
}

export interface TextGenderOptions {
  /** Подписанные имена персонажей: `speaker_1 → Лиза`. */
  names?: Record<string, string>;
  /** Окно вокруг реплики, в котором ищутся участники сцены, секунды. */
  sceneWindowSeconds?: number;
}

/** Меньше этого числа согласных улик вердикт не выносится. */
export const MIN_HITS = 2;

/** Сколько кусков текста сохраняем для показа человеку. */
const MAX_EXAMPLES = 4;

interface Votes {
  self: Record<'м' | 'ж', number>;
  address: Record<'м' | 'ж', number>;
  examples: string[];
}

const emptyVotes = (): Votes => ({ self: { м: 0, ж: 0 }, address: { м: 0, ж: 0 }, examples: [] });

/**
 * Кому адресована реплика: по названному имени, иначе по сцене, если в ней
 * ровно один второй голос. `null` — собеседник не опознан, улику не считаем.
 */
function addresseeOf(
  segments: Segment[],
  index: number,
  options: Required<Pick<TextGenderOptions, 'names' | 'sceneWindowSeconds'>>,
): string | null {
  const segment = segments[index]!;
  const named = vocativeNames(segment.text_ru ?? '');
  for (const name of named) {
    const match = Object.entries(options.names).find(([, value]) => value.toLowerCase() === name.toLowerCase());
    if (match && match[0] !== segment.speaker) return match[0];
  }
  const from = segment.start - options.sceneWindowSeconds;
  const to = segment.end + options.sceneWindowSeconds;
  const others = new Set(
    segments.filter((other) => other.end > from && other.start < to && other.speaker !== segment.speaker).map((other) => other.speaker),
  );
  return others.size === 1 ? [...others][0]! : null;
}

/**
 * Вердикт по тексту для каждого говорящего.
 *
 * Требуется не меньше `MIN_HITS` улик одного рода и ни одной противоречащей:
 * одна оговорка модели не должна менять голос персонажу на весь фильм, а
 * спорящие улики — это чаще всего цитата или пересказ чужих слов, и решать
 * такое машине нечем.
 */
export function speakerGenderByText(segments: Segment[], options: TextGenderOptions = {}): Record<string, TextGender> {
  const resolved = { names: options.names ?? {}, sceneWindowSeconds: options.sceneWindowSeconds ?? 8 };
  const votes = new Map<string, Votes>();
  const voteFor = (speaker: string): Votes => {
    const existing = votes.get(speaker) ?? emptyVotes();
    votes.set(speaker, existing);
    return existing;
  };

  for (const [index, segment] of segments.entries()) {
    const text = (segment.text_ru ?? '').trim();
    if (!text) continue;

    for (const hit of selfHits(text)) {
      const bucket = voteFor(segment.speaker);
      bucket.self[hit.gender === 'ж' ? 'ж' : 'м']++;
      if (bucket.examples.length < MAX_EXAMPLES) bucket.examples.push(hit.fragment);
    }

    const address = addressHits(text);
    if (address.length === 0) continue;
    const addressee = addresseeOf(segments, index, resolved);
    if (!addressee) continue;
    for (const hit of address) {
      const bucket = voteFor(addressee);
      bucket.address[hit.gender === 'ж' ? 'ж' : 'м']++;
      if (bucket.examples.length < MAX_EXAMPLES) bucket.examples.push(hit.fragment);
    }
  }

  const result: Record<string, TextGender> = {};
  for (const [speaker, bucket] of votes) {
    const male = bucket.self.м + bucket.address.м;
    const female = bucket.self.ж + bucket.address.ж;
    let gender: VoiceGender = '—';
    if (male >= MIN_HITS && female === 0) gender = 'м';
    if (female >= MIN_HITS && male === 0) gender = 'ж';
    result[speaker] = {
      gender,
      self: bucket.self.м + bucket.self.ж,
      address: bucket.address.м + bucket.address.ж,
      examples: bucket.examples,
    };
  }
  return result;
}
