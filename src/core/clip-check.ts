/**
 * Проверка озвученной реплики: то ли в ней сказано, что написано.
 *
 * X-Voice ошибается в отдельных репликах и каждый раз по-разному: на ролике
 * FRANCE 24 одна и та же реплика из четырёх попыток теряла последнее слово
 * один раз, а обрывок образца («сейшн») в начале проскакивал в каждой третьей.
 * Сервер распознаёт готовый клип, а здесь услышанное сверяется с текстом, и
 * неудачная реплика озвучивается заново.
 *
 * Ловится только грубое — то, что слышно сразу:
 *
 * - лишнее в начале: обрывок образца, который модель договорила;
 * - пропавшее начало или конец реплики;
 * - мало совпавших слов вообще.
 *
 * Промахи самого распознавания браком не считаются: «Anthropic» и «антропик»
 * — одно слово (латиница переводится в кириллицу по звучанию), окончания
 * прощаются, а короткие служебные слова («на», «и») в начале и в конце не
 * требуются — их распознавание и само теряет.
 */

export type ClipProblem = 'junk-start' | 'lost-start' | 'lost-end' | 'garbled';

export interface ClipVerdict {
  ok: boolean;
  /** Чем больше, тем лучше; по нему выбирается лучшая из попыток. */
  score: number;
  /** Доля значимых слов текста, найденных в услышанном. */
  coverage: number;
  problems: ClipProblem[];
}

/** Меньше этой доли совпавших слов — реплика неразборчива. */
const MIN_COVERAGE = 0.75;

const LATIN: Array<[string, string]> = [
  ['sch', 'ш'], ['sh', 'ш'], ['ch', 'ч'], ['th', 'т'], ['ph', 'ф'], ['zh', 'ж'], ['kh', 'х'],
  ['oo', 'у'], ['ee', 'и'], ['ya', 'я'], ['yu', 'ю'], ['yo', 'ё'],
  ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'], ['f', 'ф'], ['g', 'г'], ['h', 'х'],
  ['i', 'и'], ['j', 'дж'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'],
  ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['v', 'в'], ['w', 'в'], ['x', 'кс'],
  ['y', 'и'], ['z', 'з'],
];

/** Латиница — в кириллицу по звучанию: сравниваются слова, а не алфавиты. */
function cyrillic(word: string): string {
  let out = '';
  for (let index = 0; index < word.length; ) {
    const pair = LATIN.find(([latin]) => word.startsWith(latin, index));
    if (pair) {
      out += pair[1];
      index += pair[0].length;
    } else {
      out += word[index];
      index++;
    }
  }
  return out;
}

/** Слова для сравнения: без регистра, знаков и «ё». */
export function clipWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => cyrillic(word).replace(/ё/g, 'е').replace(/ь|ъ/g, ''));
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * Слово на слух: гласные, которые в безударном положении звучат одинаково или
 * которые распознавание путает в именах («Итан» и «Эйтан»), сведены вместе.
 */
function sound(word: string): string {
  return word.replace(/[эиыйе]/g, 'и').replace(/[оа]/g, 'а').replace(/я/g, 'а').replace(/ю/g, 'у');
}

/** Одно ли это слово — с поправкой на окончания и на промахи распознавания. */
function same(first: string, second: string): boolean {
  if (first === second) return true;
  const a = sound(first);
  const b = sound(second);
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter <= 2) return false;
  // Общая основа: «переговоры» и «переговорах» — одно слово для уха.
  let prefix = 0;
  while (prefix < shorter && a[prefix] === b[prefix]) prefix++;
  if (prefix >= 4 && prefix >= shorter - 2) return true;
  return distance(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.3));
}

/** Есть ли среди слов значимое — не предлог и не союз. */
const meaningful = (words: string[]): boolean => words.some((word) => word.length >= 3);

/**
 * Пары совпавших слов (индекс в тексте, индекс в услышанном) по порядку.
 * Незнакомое имя распознавание может разбить надвое — «Натарсоа» слышится
 * как «на тарса»: слово текста совпадает и с двумя услышанными подряд.
 */
function align(expected: string[], heard: string[]): Array<[number, number]> {
  const n = expected.length;
  const m = heard.length;
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 2).fill(0));
  const split = (i: number, j: number): boolean => j + 1 < m && expected[i]!.length >= 5 && same(expected[i]!, heard[j]! + heard[j + 1]!);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      if (same(expected[i]!, heard[j]!)) best = Math.max(best, table[i + 1]![j + 1]! + 1);
      if (split(i, j)) best = Math.max(best, table[i + 1]![j + 2]! + 1);
      table[i]![j] = best;
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (same(expected[i]!, heard[j]!) && table[i]![j] === table[i + 1]![j + 1]! + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (split(i, j) && table[i]![j] === table[i + 1]![j + 2]! + 1) {
      pairs.push([i, j]);
      i++;
      j += 2;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}


export function judgeClip(text: string, heardText: string): ClipVerdict {
  const expected = clipWords(text);
  const heard = clipWords(heardText);
  /*
   * Междометие («Ох...», «А?») проверять нечем: на полусекунде звука
   * распознавание выдумывает целые фразы — «Продолжение следует...».
   */
  if (!meaningful(expected)) return { ok: true, score: 1, coverage: 1, problems: [] };
  if (heard.length === 0) return { ok: false, score: 0, coverage: 0, problems: ['garbled'] };

  const pairs = align(expected, heard);
  // Доля — по значимым словам: «на» и «и» распознавание теряет и в чистом звуке.
  const counted = expected.map((word) => word.length >= 3);
  const total = counted.filter(Boolean).length;
  const coverage = pairs.filter(([index]) => counted[index]).length / total;
  const problems: ClipProblem[] = [];

  // Обрывок, приклеенный распознаванием к первому слову: «сейшнсистемы».
  const glued = heard[0]!.length >= expected[0]!.length + 3 && heard[0]!.endsWith(expected[0]!);
  if (glued) problems.push('junk-start');
  if (pairs.length > 0) {
    const [firstExpected, firstHeard] = pairs[0]!;
    const [lastExpected] = pairs[pairs.length - 1]!;
    // Слышно лишнее до первого слова текста.
    if (firstExpected === 0 && meaningful(heard.slice(0, firstHeard))) problems.push('junk-start');
    if (meaningful(expected.slice(glued ? 1 : 0, firstExpected))) problems.push('lost-start');
    if (meaningful(expected.slice(lastExpected + 1))) problems.push('lost-end');
  }
  if (coverage < MIN_COVERAGE) problems.push('garbled');

  const unique = [...new Set(problems)];
  const penalty = unique.reduce((sum, problem) => sum + (problem === 'junk-start' ? 0.5 : problem === 'garbled' ? 0 : 0.3), 0);
  return { ok: unique.length === 0, score: Number((coverage - penalty).toFixed(3)), coverage: Number(coverage.toFixed(3)), problems: unique };
}
