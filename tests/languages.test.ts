import { describe, it, expect } from 'vitest';
import { languageProfile, LANGUAGE_PROFILES } from '../src/core/languages.js';
import { boundedTargetChars, targetChars } from '../src/stages/s3-translate.js';
import { mergeWordsIntoSentences } from '../src/stages/s2-segments.js';
import { optionsForLanguage, splitLongText, subtitleFileName, DEFAULT_SUBTITLE_OPTIONS } from '../src/stages/subtitles.js';

/**
 * Конвейер писался под английский оригинал. Эти тесты закрепляют, что язык
 * стал параметром: там, где правило зависит от письменности, оно берётся
 * из профиля языка, а не из зашитого умолчания.
 */

describe('FR-2: профиль языка оригинала', () => {
  it('знакомые языки описаны, незнакомый получает латинские правила', () => {
    expect(languageProfile('ko').name).toBe('корейский');
    expect(languageProfile('zh').wordJoiner).toBe('');
    const unknown = languageProfile('sw');
    expect(unknown.code).toBe('sw');
    expect(unknown.wordJoiner).toBe(' ');
    expect(unknown.expansionCap).toBe(LANGUAGE_PROFILES['en']!.expansionCap);
  });

  it('код языка нормализуется: регистр и региональный суффикс', () => {
    expect(languageProfile('KO').code).toBe('ko');
    expect(languageProfile('zh-CN').code).toBe('zh');
    expect(languageProfile('pt_BR').code).toBe('pt');
    expect(languageProfile('').code).toBe('en');
  });

  it('у письменностей без пробелов строка субтитра короче и читается медленнее', () => {
    const en = languageProfile('en');
    const zh = languageProfile('zh');
    expect(zh.subtitleLineChars).toBeLessThan(en.subtitleLineChars);
    expect(zh.subtitleCps).toBeLessThan(en.subtitleCps);
    expect(zh.sentenceEnders).toContain('。');
  });
});

describe('FR-3: предел длины перевода зависит от письменности', () => {
  it('иероглифы несут больше смысла, поэтому предел выше', () => {
    const slot = 60;
    const chinese = '你好吗今天天气怎么样';
    // По слоту цель огромна, значит решает предел от длины оригинала.
    const byLatin = boundedTargetChars(chinese, slot, 11.5, languageProfile('en').expansionCap);
    const byChinese = boundedTargetChars(chinese, slot, 11.5, languageProfile('zh').expansionCap);
    expect(byLatin).toBe(20);
    expect(byChinese).toBe(50);
  });

  it('слот по-прежнему сильнее предела, когда он меньше', () => {
    const text = 'a'.repeat(200);
    expect(boundedTargetChars(text, 1, 11.5, 5)).toBe(targetChars(1, 11.5));
  });
});

describe('FR-2: склейка слов без пробелов', () => {
  const word = (text: string, start: number, end: number) => ({ word: text, start, end });

  it('китайские слова склеиваются без пробелов', () => {
    const [segment] = mergeWordsIntoSentences([word('你', 0, 0.2), word('好', 0.2, 0.4), word('吗', 0.4, 0.6)], {
      wordJoiner: languageProfile('zh').wordJoiner,
    });
    expect(segment!.text).toBe('你好吗');
  });

  it('для языков с пробелами ничего не меняется', () => {
    const [segment] = mergeWordsIntoSentences([word('How', 0, 0.3), word('are', 0.3, 0.6), word('you', 0.6, 0.9)], {
      wordJoiner: languageProfile('en').wordJoiner,
    });
    expect(segment!.text).toBe('How are you');
  });
});

describe('FR-8: субтитры на языке оригинала', () => {
  it('имя файла строится по коду языка', () => {
    expect(subtitleFileName('C:/video/lecture.mkv', 'ko')).toBe('lecture.ko.srt');
    expect(subtitleFileName('C:/video/lecture.mkv', 'ru')).toBe('lecture.ru.srt');
  });

  it('длинная фраза делится по полноширинным знакам препинания', () => {
    const parts = splitLongText('第一句话在这里。第二句话也在这里。第三句话在最后。', 12, languageProfile('zh').sentenceEnders);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toBe('第一句话在这里。');
    // С латинскими правилами та же строка не делится по смыслу.
    expect(splitLongText('第一句话在这里。第二句话也在这里。', 12, '.!?…').every((part) => part.includes('。'))).toBe(true);
  });

  it('нормы строки берутся по языку, но настройка пользователя важнее', () => {
    const forChinese = optionsForLanguage(DEFAULT_SUBTITLE_OPTIONS, 'zh');
    expect(forChinese.maxLineChars).toBe(languageProfile('zh').subtitleLineChars);
    expect(forChinese.maxCps).toBe(languageProfile('zh').subtitleCps);

    const custom = { ...DEFAULT_SUBTITLE_OPTIONS, maxLineChars: 30, maxCps: 14 };
    const kept = optionsForLanguage(custom, 'zh');
    expect(kept.maxLineChars).toBe(30);
    expect(kept.maxCps).toBe(14);
  });

  it('для английского правила остаются прежними', () => {
    const forEnglish = optionsForLanguage(DEFAULT_SUBTITLE_OPTIONS, 'en');
    expect(forEnglish.maxLineChars).toBe(DEFAULT_SUBTITLE_OPTIONS.maxLineChars);
    expect(forEnglish.maxCps).toBe(DEFAULT_SUBTITLE_OPTIONS.maxCps);
  });
});
