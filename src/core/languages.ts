/**
 * Язык оригинала как параметр, а не как английский по умолчанию (ТЗ FR-2, FR-3, FR-8).
 *
 * Конвейер писался под английский, и часть правил молча это предполагала: перевод
 * не длиннее оригинала более чем вдвое, слова склеиваются пробелом, строка
 * субтитра — 42 символа. Для языков с другой письменностью каждое из этих
 * допущений неверно: иероглиф несёт больше смысла, чем буква, в китайском и
 * японском между словами нет пробелов, а иероглифы шире и читаются медленнее.
 *
 * Здесь собраны отличия, которые действительно влияют на результат. Язык, для
 * которого профиля нет, получает латинские правила — они безопаснее всего для
 * алфавитных письменностей.
 */

export interface LanguageProfile {
  /** Код языка в нотации whisper: en, ko, zh, ja… */
  code: string;
  /** Название на русском — для сообщений и промпта перевода. */
  name: string;
  /** Название на английском — для промпта и англоязычного интерфейса. */
  nameEn: string;
  /**
   * Во сколько раз перевод может быть длиннее оригинала по символам.
   * Защищает от выдумывания текста, которого в оригинале нет; для письменностей
   * плотнее латиницы предел должен быть выше, иначе перевод обрубается.
   */
  expansionCap: number;
  /** Чем склеивать слова распознавателя: в языках без пробелов — пустой строкой. */
  wordJoiner: string;
  /** Максимум символов в строке субтитра. */
  subtitleLineChars: number;
  /** Предел скорости чтения субтитров, символов в секунду. */
  subtitleCps: number;
  /** Знаки конца предложения — по ним делится длинная реплика в субтитрах. */
  sentenceEnders: string;
}

/** Латинские правила: они же действуют для языка без собственного профиля. */
const LATIN: Omit<LanguageProfile, 'code' | 'name' | 'nameEn'> = {
  expansionCap: 2,
  wordJoiner: ' ',
  subtitleLineChars: 42,
  subtitleCps: 17,
  sentenceEnders: '.!?…',
};

/**
 * Письменности без пробелов между словами. Знаки препинания — полноширинные,
 * норма строки субтитра вдвое короче латинской, читаются иероглифы медленнее.
 */
const CJK: Omit<LanguageProfile, 'code' | 'name' | 'nameEn'> = {
  expansionCap: 5,
  wordJoiner: '',
  subtitleLineChars: 18,
  subtitleCps: 9,
  sentenceEnders: '.!?…。！？',
};

export const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  en: { code: 'en', name: 'английский', nameEn: 'English', ...LATIN },
  ru: { code: 'ru', name: 'русский', nameEn: 'Russian', ...LATIN, expansionCap: 2.5 },
  de: { code: 'de', name: 'немецкий', nameEn: 'German', ...LATIN },
  fr: { code: 'fr', name: 'французский', nameEn: 'French', ...LATIN },
  es: { code: 'es', name: 'испанский', nameEn: 'Spanish', ...LATIN },
  it: { code: 'it', name: 'итальянский', nameEn: 'Italian', ...LATIN },
  pt: { code: 'pt', name: 'португальский', nameEn: 'Portuguese', ...LATIN },
  pl: { code: 'pl', name: 'польский', nameEn: 'Polish', ...LATIN },
  tr: { code: 'tr', name: 'турецкий', nameEn: 'Turkish', ...LATIN },
  uk: { code: 'uk', name: 'украинский', nameEn: 'Ukrainian', ...LATIN },
  // Корейский: пробелы есть, но слог хангыля плотнее латинской буквы.
  ko: { code: 'ko', name: 'корейский', nameEn: 'Korean', ...LATIN, expansionCap: 3, subtitleLineChars: 20, subtitleCps: 12, sentenceEnders: '.!?…。！？' },
  zh: { code: 'zh', name: 'китайский', nameEn: 'Chinese', ...CJK },
  ja: { code: 'ja', name: 'японский', nameEn: 'Japanese', ...CJK },
  th: { code: 'th', name: 'тайский', nameEn: 'Thai', ...CJK, expansionCap: 3, subtitleLineChars: 35, subtitleCps: 12 },
};

/** Профиль языка; для незнакомого кода — латинские правила под его же кодом. */
export function languageProfile(code: string): LanguageProfile {
  const normalized = (code || 'en').toLowerCase().split(/[-_]/)[0] ?? 'en';
  return (
    LANGUAGE_PROFILES[normalized] ?? {
      code: normalized,
      name: normalized,
      nameEn: normalized,
      ...LATIN,
    }
  );
}

/** Регулярное выражение «кусок текста до конца предложения включительно». */
export function sentencePattern(profile: LanguageProfile): RegExp {
  const enders = profile.sentenceEnders.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`[^${enders}]+[${enders}]*\\s*`, 'g');
}
