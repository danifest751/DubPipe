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
 * Улика честная, не круговая: пол сообщают переводчику только для говорящих,
 * чей голос уже решён (по тону или человеком). У остальных — тех, о ком тон
 * промолчал и для кого эта улика и нужна, — род выбран из смысла сцены, а не
 * переписан из нашего же замера.
 *
 * Улик две, и они разной прочности. Первое лицо говорит о том, кто произносит
 * реплику, — гадать не о чем. Обращение говорит о собеседнике, а кто собеседник,
 * конвейер знает не всегда: засчитываем, только если в реплике названо имя
 * подписанного персонажа либо в сцене ровно один второй голос.
 */

/** Краткие прилагательные и местоимения, у которых род виден без глагола: «мужской — женский». */
const SHORT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['должен', 'должна'], ['рад', 'рада'], ['готов', 'готова'], ['уверен', 'уверена'], ['сам', 'сама'],
  ['один', 'одна'], ['виноват', 'виновата'], ['прав', 'права'], ['обязан', 'обязана'],
  ['согласен', 'согласна'], ['вынужден', 'вынуждена'], ['зол', 'зла'], ['болен', 'больна'],
  ['счастлив', 'счастлива'], ['свободен', 'свободна'], ['голоден', 'голодна'], ['занят', 'занята'],
  ['удивлён', 'удивлена'], ['благодарен', 'благодарна'], ['влюблён', 'влюблена'], ['ранен', 'ранена'],
  ['способен', 'способна'], ['доволен', 'довольна'], ['знаком', 'знакома'], ['жив', 'жива'],
  ['нужен', 'нужна'], ['спокоен', 'спокойна'], ['напуган', 'напугана'], ['измотан', 'измотана'],
];
const SHORT_MALE = new Set(SHORT_PAIRS.map(([male]) => male));
const SHORT_FEMALE = new Set(SHORT_PAIRS.map(([, female]) => female));

/**
 * Глаголы прошедшего времени, у которых мужская форма не кончается на «л»:
 * «я мог», «я пришёл». Правило окончаний их не видит — и «я могла» у мужского
 * голоса находилось, а «я мог» у женского проходило молча. Основа → женская форма.
 *
 * «мёл» (смёл) сюда намеренно не входит: «смела» — ещё и краткое прилагательное,
 * и «я смела» превратилось бы в «я смёл» вместо «я смел».
 */
const IRREGULAR_STEMS: ReadonlyArray<readonly [string, string]> = [
  ['шёл', 'шла'], ['шел', 'шла'], ['мог', 'могла'], ['лёг', 'легла'], ['лег', 'легла'], ['умер', 'умерла'],
  ['нёс', 'несла'], ['нес', 'несла'], ['вёз', 'везла'], ['вёл', 'вела'], ['рос', 'росла'], ['тёр', 'тёрла'],
  ['пёк', 'пекла'], ['лез', 'лезла'], ['полз', 'ползла'], ['жёг', 'жгла'], ['мёрз', 'мёрзла'], ['мерз', 'мерзла'],
  ['брёл', 'брела'], ['цвёл', 'цвела'], ['плёл', 'плела'],
];

/** Приставки, с которыми эти основы встречаются в речи: «при-шёл», «с-мог», «вы-рос». */
const PREFIXES = ['', 'с', 'по', 'вы', 'при', 'у', 'за', 'на', 'от', 'ото', 'пере', 'до', 'об', 'обо', 'под', 'подо', 'про', 'раз', 'разо', 'из', 'изо', 'в', 'во', 'вз', 'со'];

/** Неправильные глаголы, не сводимые к основе выше, — целиком. */
const IRREGULAR_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['спас', 'спасла'], ['запер', 'заперла'], ['отпер', 'отперла'], ['берёг', 'берегла'], ['уберёг', 'уберегла'],
  ['сберёг', 'сберегла'], ['привык', 'привыкла'], ['отвык', 'отвыкла'], ['исчез', 'исчезла'],
  ['достиг', 'достигла'], ['постиг', 'постигла'],
];

/** Словарь пар для перестановки рода: неправильные глаголы и краткие формы. */
const TO_FEMALE = new Map<string, string>();
const TO_MALE = new Map<string, string>();
for (const [male, female] of [
  ...IRREGULAR_WORDS,
  ...IRREGULAR_STEMS.flatMap(([m, f]) => PREFIXES.map((prefix) => [prefix + m, prefix + f] as const)),
  ...SHORT_PAIRS,
]) {
  if (!TO_FEMALE.has(male)) TO_FEMALE.set(male, female);
  if (!TO_MALE.has(female)) TO_MALE.set(female, male);
}

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
  // «нашёлся» и «нашлась»: род у возвратного глагола — род его основы.
  const core = lower.length > 4 && /с[яь]$/.test(lower) ? lower.slice(0, -2) : lower;
  if (TO_FEMALE.has(core)) return 'м';
  if (TO_MALE.has(core)) return 'ж';
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

/*
 * Согласование рода с голосом.
 *
 * Переводчик выбирает род первого лица сам: в английском «I could» рода нет, и
 * модель угадывает его по сцене. Голос же назначается по тону актёра. Когда они
 * расходятся, мужской голос произносит «я могла» — и это слышно сразу. Правило
 * простое: род того, что говорящий говорит о себе, определяет голос, который
 * реплику произносит. Применяется оно после модели, а не только в промпте:
 * подсказку модель слушает не всегда, а голос могли сменить в панели уже после
 * перевода.
 *
 * Исправление морфологическое, без нового запроса к модели: слово меняет только
 * окончание, длина реплики сдвигается на знак-два, и укладка не страдает.
 */

type Gender = 'м' | 'ж';

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase();
  return original[0] === original[0]!.toUpperCase() ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement;
}

/**
 * То же слово в другом роде: «могла» → «мог», «испугался» → «испугалась»,
 * «рада» → «рад». `null` — слово рода не показывает, уже нужного рода или
 * переставить его не умеем.
 */
export function flipGender(word: string, to: Gender): string | null {
  const lower = word.toLowerCase();
  const from = markWord(lower);
  if (from === null || from === '—' || from === to) return null;

  // Возвратная частица снимается и возвращается в форме нужного рода:
  // «испугался» → «испугал» + «сь», «нашлась» → «нашла» → «нашёл» + «ся».
  let core = lower;
  let tail = '';
  if (lower.length > 4 && /с[яь]$/.test(lower)) {
    core = lower.slice(0, -2);
    tail = to === 'ж' ? 'сь' : 'ся';
  }

  let result = (to === 'ж' ? TO_FEMALE : TO_MALE).get(core) ?? null;
  if (result === null) {
    if (to === 'ж') {
      if (core.endsWith('ёл')) result = `${core.slice(0, -2)}ела`;
      else if (core.endsWith('л')) result = `${core}а`;
    } else if (core.endsWith('ла')) {
      result = core.slice(0, -1);
    }
  }
  return result === null ? null : matchCase(word, result + tail);
}

/** Знаки, на которых кончается предложение: дальше «я» уже не подлежащее. */
const SENTENCE_END = /[.!?;…]/;
/** Союзы, через которые одно «я» тянет второе сказуемое: «я пришла и сказала». */
const JOINERS = new Set(['и', 'а', 'но', 'или', 'потом', 'затем']);
/** Слова, за которыми начинается чужое подлежащее: «я знаю, что она пришла». */
const OTHER_SUBJECTS = new Set(['он', 'она', 'оно', 'они', 'я', 'ты', 'вы', 'мы', 'это', 'кто', 'что']);
/** «Сам» относится к подлежащему, где бы в предложении ни стоял: «я сделал это сам». */
const EMPHATIC = new Set(['сам', 'сама']);
/** До «сам» подлежащее сменяет только личное местоимение: «это» там дополнение. */
const PERSONAL = new Set(['он', 'она', 'оно', 'они', 'я', 'ты', 'вы', 'мы']);

export interface GenderFix {
  from: string;
  to: string;
}

/**
 * Приводит к нужному роду всё, что относится к местоимению: сказуемое в окне из
 * трёх слов, краткое прилагательное сразу за ним («я была рада»), однородные
 * сказуемые через союз («я пришла и сказала») и «сам» до конца предложения («я
 * сделал это сам»). Слова при других подлежащих («я знаю, что она пришла») не
 * трогает.
 */
export function agreePronoun(text: string, pronoun: 'я' | 'ты', gender: Gender): { text: string; fixes: GenderFix[] } {
  // Нечётные элементы — слова, чётные — всё между ними.
  const parts = text.split(/([а-яёА-ЯЁ]+)/);
  const fixes: GenderFix[] = [];
  const wordAt = (index: number) => parts[index]!.toLowerCase();
  const nextWord = (index: number): number | null => {
    const next = index + 2;
    if (next >= parts.length || SENTENCE_END.test(parts[index + 1] ?? '')) return null;
    return next;
  };
  const fix = (index: number) => {
    const flipped = flipGender(parts[index]!, gender);
    if (flipped === null) return;
    fixes.push({ from: parts[index]!, to: flipped });
    parts[index] = flipped;
  };

  for (let index = 1; index < parts.length; index += 2) {
    if (wordAt(index) !== pronoun) continue;
    // Сказуемое: ближайшее слово с видимым родом не дальше трёх слов.
    let hit: number | null = null;
    let cursor: number | null = index;
    for (let step = 0; step < WINDOW; step++) {
      cursor = cursor === null ? null : nextWord(cursor);
      if (cursor === null) break;
      if (OTHER_SUBJECTS.has(wordAt(cursor))) break;
      if (markWord(parts[cursor]!) !== null) {
        hit = cursor;
        break;
      }
    }
    let last = index;
    while (hit !== null) {
      fix(hit);
      last = hit;
      let after = nextWord(hit);
      // «я была рада», «я был уверен»: краткое прилагательное при связке.
      if (after !== null && (SHORT_MALE.has(wordAt(after)) || SHORT_FEMALE.has(wordAt(after)))) {
        fix(after);
        after = nextWord(after);
      }
      // Однородное сказуемое через союз: «я пришла и сказала».
      hit = null;
      if (after !== null && JOINERS.has(wordAt(after))) {
        let probe: number | null = after;
        for (let step = 0; step < 2; step++) {
          probe = probe === null ? null : nextWord(probe);
          if (probe === null || OTHER_SUBJECTS.has(wordAt(probe))) break;
          if (markWord(parts[probe]!) !== null) {
            hit = probe;
            break;
          }
        }
      }
    }
    // «Сам» — до конца предложения, пока не появилось другое подлежащее.
    for (let cursor = nextWord(last); cursor !== null; cursor = nextWord(cursor)) {
      if (PERSONAL.has(wordAt(cursor))) break;
      if (EMPHATIC.has(wordAt(cursor))) fix(cursor);
    }
  }
  return { text: parts.join(''), fixes };
}

/** Род всего, что говорящий говорит о себе. */
export function agreeFirstPerson(text: string, gender: Gender): { text: string; fixes: GenderFix[] } {
  return agreePronoun(text, 'я', gender);
}

export interface AgreedLine {
  id: number;
  before: string;
  after: string;
}

/**
 * Подгоняет род в репликах под пол голосов.
 *
 * То, что говорящий говорит о себе («я пришла»), — под пол его собственного
 * голоса. Обращение («ты пришла») — под пол голоса собеседника, если тот
 * опознан: назван по имени или остался единственным другим голосом в сцене;
 * иначе не трогается. Говорящий без известного пола не трогается тоже.
 *
 * Разметка фраз правится теми же заменами, что и сам текст: иначе синтез по
 * фразам произнёс бы прежний род.
 */
export function agreeWithVoices(
  segments: Segment[],
  genders: Record<string, Gender>,
  options: TextGenderOptions = {},
): AgreedLine[] {
  const resolved = { names: options.names ?? {}, sceneWindowSeconds: options.sceneWindowSeconds ?? 8 };
  const changed: AgreedLine[] = [];
  for (const [index, segment] of segments.entries()) {
    if (!segment.text_ru) continue;
    const fixes: GenderFix[] = [];
    let text = segment.text_ru;
    const own = genders[segment.speaker];
    if (own) {
      const self = agreePronoun(text, 'я', own);
      text = self.text;
      fixes.push(...self.fixes);
    }
    if (addressHits(text).length > 0) {
      const addressee = addresseeOf(segments, index, resolved);
      const theirs = addressee ? genders[addressee] : undefined;
      if (theirs) {
        const other = agreePronoun(text, 'ты', theirs);
        text = other.text;
        fixes.push(...other.fixes);
      }
    }
    if (fixes.length === 0) continue;
    changed.push({ id: segment.id, before: segment.text_ru!, after: text });
    segment.text_ru = text;
    if (segment.phrases) {
      segment.phrases = segment.phrases.map((phrase) =>
        fixes.reduce((piece, { from, to }) => piece.replace(new RegExp(`(?<![а-яёА-ЯЁ])${from}(?![а-яёА-ЯЁ])`), to), phrase),
      );
    }
  }
  return changed;
}
