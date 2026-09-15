import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { DubConfig } from '../config/schema.js';
import { log } from '../core/logger.js';
import { languageProfile } from '../core/languages.js';
import { formatTimestamp } from '../util/srt.js';
import { warn, type Segment, type StageWarning } from '../core/types.js';

/**
 * Субтитры: раскладка реплик в SRT по принятым правилам читаемости.
 *
 * Реплики конвейера — не субтитры: они нарезаны под озвучку, могут быть длиной
 * в одно слово или в четыре строки текста. Зритель же читает глазами, поэтому
 * действуют правила, общие для вещателей и стриминга: не больше двух строк,
 * ограничение символов в строке, минимальная и максимальная длительность,
 * зазор между соседними титрами и предел скорости чтения (символов в секунду).
 *
 * На выходе — два файла рядом с видео: `имя.en.srt` и `имя.ru.srt`.
 */

export interface SubtitleOptions {
  /** Максимум символов в строке (42 — общий знаменатель Netflix/BBC). */
  maxLineChars: number;
  /** Максимум строк в титре. */
  maxLines: number;
  /** Минимальная длительность титра, с. */
  minDurationSeconds: number;
  /** Максимальная длительность титра, с. */
  maxDurationSeconds: number;
  /** Зазор между соседними титрами, мс (2 кадра при 24 к/с ≈ 84 мс). */
  gapMs: number;
  /** Предел скорости чтения, символов в секунду. */
  maxCps: number;
  /** Знаки конца предложения языка этого файла: в CJK они полноширинные. */
  sentenceEnders?: string;
}

export const DEFAULT_SUBTITLE_OPTIONS: SubtitleOptions = {
  maxLineChars: 42,
  maxLines: 2,
  minDurationSeconds: 1,
  maxDurationSeconds: 7,
  gapMs: 84,
  maxCps: 17,
  sentenceEnders: '.!?…',
};

/**
 * Правила титра для конкретного языка: у иероглифических письменностей строка
 * короче, а читаются они медленнее. Значение, заданное пользователем в
 * настройках, важнее языкового умолчания — поэтому подменяются только те поля,
 * которые остались стандартными.
 */
export function optionsForLanguage(base: SubtitleOptions, code: string): SubtitleOptions {
  const profile = languageProfile(code);
  return {
    ...base,
    maxLineChars:
      base.maxLineChars === DEFAULT_SUBTITLE_OPTIONS.maxLineChars ? profile.subtitleLineChars : base.maxLineChars,
    maxCps: base.maxCps === DEFAULT_SUBTITLE_OPTIONS.maxCps ? profile.subtitleCps : base.maxCps,
    sentenceEnders: profile.sentenceEnders,
  };
}

export interface Cue {
  /** Номер по порядку, с единицы. */
  index: number;
  start: number;
  end: number;
  lines: string[];
  /** Из какой реплики получен титр — чтобы редактор связывал их между собой. */
  segmentId: number;
}

export type CueProblem = 'too_fast' | 'too_short' | 'too_long' | 'line_overflow' | 'too_many_lines' | 'overlap';

/** Слова, которые не должны оставаться в конце строки: читается как обрыв мысли. */
const CLINGING = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'as', 'by', 'is', 'it',
  'и', 'а', 'но', 'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'о', 'об', 'от', 'до', 'из', 'за', 'по', 'у', 'не', 'ни',
  'что', 'как', 'же', 'бы', 'ли', 'при', 'для', 'под', 'над', 'без', 'про',
]);

export function charCount(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

/** Длительность, за которую текст успевают прочитать при заданной скорости. */
export function readingSeconds(text: string, maxCps: number): number {
  return charCount(text) / Math.max(1, maxCps);
}

/**
 * Делит текст на строки: сначала по знакам препинания, затем по ближайшему
 * к середине пробелу, не оставляя в конце строки предлог или союз.
 */
export function wrapCueText(text: string, maxLineChars: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxLineChars || maxLines <= 1) return [clean];

  const words = clean.split(' ');
  // Точка баланса: строки примерно равной длины читаются легче «рваных».
  const target = clean.length / Math.min(maxLines, Math.ceil(clean.length / maxLineChars));

  let bestCut = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let width = 0;
  for (let i = 0; i < words.length - 1; i++) {
    width += words[i]!.length + (i > 0 ? 1 : 0);
    if (width > maxLineChars) break;
    const rest = clean.length - width - 1;
    const word = words[i]!.toLowerCase().replace(/[^\p{L}]/gu, '');
    // Штрафы: за перекос строк, за предлог в конце и за разрыв там, где нет знака препинания.
    let score = Math.abs(width - target);
    if (CLINGING.has(word)) score += maxLineChars;
    if (/[.!?…,;:—]$/.test(words[i]!)) score -= maxLineChars / 3;
    if (rest > maxLineChars * (maxLines - 1)) score += maxLineChars;
    if (score < bestScore) {
      bestScore = score;
      bestCut = i;
    }
  }

  if (bestCut < 0) {
    // Ни один разрыв не влезает: режем по максимуму строки, по границе слова.
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxLineChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
      if (lines.length === maxLines - 1 && current.length > maxLineChars) break;
    }
    if (current) lines.push(current);
    return lines.slice(0, maxLines);
  }

  const first = words.slice(0, bestCut + 1).join(' ');
  const rest = words.slice(bestCut + 1).join(' ');
  return [first, ...wrapCueText(rest, maxLineChars, maxLines - 1)];
}

/**
 * Если текст не помещается в титр целиком, делит его на несколько частей
 * по границам предложений, а при их отсутствии — по словам.
 */
export function splitLongText(text: string, capacity: number, sentenceEnders = '.!?…'): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= capacity) return [clean];

  // В китайском и японском конец предложения — полноширинные знаки 。！？
  const escaped = sentenceEnders.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`[^${escaped}]+[${escaped}]*\\s*`, 'g');
  const sentences = clean.match(pattern)?.map((part) => part.trim()).filter(Boolean) ?? [clean];
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > capacity && current) {
      parts.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);

  // Отдельное предложение всё ещё длиннее ёмкости — режем по словам.
  return parts.flatMap((part) => {
    if (part.length <= capacity) return [part];
    const words = part.split(' ');
    const chunks: string[] = [];
    let chunk = '';
    for (const word of words) {
      const candidate = chunk ? `${chunk} ${word}` : word;
      if (candidate.length > capacity && chunk) {
        chunks.push(chunk);
        chunk = word;
      } else {
        chunk = candidate;
      }
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  });
}

interface PlanItem {
  id: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Строит титры: делит длинный текст, раскладывает время между частями,
 * выдерживает минимум и максимум длительности и зазор между соседями.
 */
export function planCues(items: PlanItem[], options: SubtitleOptions = DEFAULT_SUBTITLE_OPTIONS): Cue[] {
  const capacity = options.maxLineChars * options.maxLines;
  const gap = options.gapMs / 1000;
  const raw: Cue[] = [];

  for (const item of items) {
    const text = item.text.replace(/\s+/g, ' ').trim();
    if (!text || item.end <= item.start) continue;

    const parts = splitLongText(text, capacity, options.sentenceEnders);
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    let cursor = item.start;
    const span = item.end - item.start;

    parts.forEach((part, index) => {
      const share = (part.length / totalChars) * span;
      const last = index === parts.length - 1;
      const end = last ? item.end : Math.min(item.end, cursor + share);
      raw.push({
        index: 0,
        start: Number(cursor.toFixed(3)),
        end: Number(Math.max(end, cursor + 0.2).toFixed(3)),
        lines: wrapCueText(part, options.maxLineChars, options.maxLines),
        segmentId: item.id,
      });
      cursor = end + (last ? 0 : gap);
    });
  }

  raw.sort((a, b) => a.start - b.start);

  // Длительность: растянуть слишком короткие (если есть куда), обрезать длинные,
  // развести соседей на зазор. Сдвигать начало нельзя — оно привязано к речи.
  for (let i = 0; i < raw.length; i++) {
    const cue = raw[i]!;
    const next = raw[i + 1];
    const ceiling = next ? next.start - gap : Number.POSITIVE_INFINITY;

    let end = cue.end;
    const text = cue.lines.join(' ');
    const comfortable = Math.max(options.minDurationSeconds, readingSeconds(text, options.maxCps));
    if (end - cue.start < comfortable) end = cue.start + comfortable;
    if (end - cue.start > options.maxDurationSeconds) end = cue.start + options.maxDurationSeconds;
    if (end > ceiling) end = Math.max(cue.start + 0.2, ceiling);
    cue.end = Number(end.toFixed(3));
  }

  return raw.map((cue, index) => ({ ...cue, index: index + 1 }));
}

/** Что не так с титром по правилам читаемости — для подсветки в редакторе. */
export function cueProblems(cue: Cue, next: Cue | undefined, options: SubtitleOptions = DEFAULT_SUBTITLE_OPTIONS): CueProblem[] {
  const problems: CueProblem[] = [];
  const duration = cue.end - cue.start;
  const chars = charCount(cue.lines.join(' '));
  if (duration <= 0 || duration + 0.001 < options.minDurationSeconds) problems.push('too_short');
  if (duration > options.maxDurationSeconds + 0.001) problems.push('too_long');
  if (duration > 0 && chars / duration > options.maxCps + 0.5) problems.push('too_fast');
  if (cue.lines.some((line) => line.length > options.maxLineChars)) problems.push('line_overflow');
  if (cue.lines.length > options.maxLines) problems.push('too_many_lines');
  if (next && cue.end > next.start) problems.push('overlap');
  return problems;
}

export function formatSrt(cues: Cue[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.lines.join('\n')}\n`)
    .join('\n');
}

/** Разбор SRT — чтобы редактор читал файл, правленный снаружи. */
export function parseSrt(text: string): Cue[] {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2) continue;
    const timing = lines.find((line) => line.includes('-->'));
    if (!timing) continue;
    const match = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(timing);
    if (!match) continue;
    const toSeconds = (h: string, m: string, s: string, ms: string) =>
      Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    const body = lines.slice(lines.indexOf(timing) + 1);
    cues.push({
      index: cues.length + 1,
      start: toSeconds(match[1]!, match[2]!, match[3]!, match[4]!),
      end: toSeconds(match[5]!, match[6]!, match[7]!, match[8]!),
      lines: body,
      segmentId: -1,
    });
  }
  return cues;
}

export function subtitleOptionsFrom(config: DubConfig): SubtitleOptions {
  return {
    maxLineChars: config.subtitles.max_line_chars,
    maxLines: config.subtitles.max_lines,
    minDurationSeconds: config.subtitles.min_duration_ms / 1000,
    maxDurationSeconds: config.subtitles.max_duration_ms / 1000,
    gapMs: config.subtitles.gap_ms,
    maxCps: config.subtitles.max_cps,
  };
}

/** Имя файла субтитров по имени входа и коду языка: `эпизод.mp4` → `эпизод.ko.srt`. */
export function subtitleFileName(input: string, lang: string): string {
  const base = /^https?:\/\//i.test(input) ? 'subtitles' : path.basename(input, path.extname(input));
  return `${base}.${lang}.srt`;
}

export interface SubtitleResult {
  files: Array<{ lang: string; kind: 'source' | 'target'; path: string; cues: number }>;
  warnings: StageWarning[];
}

/** Пишет оба файла субтитров; русский — только если реплики переведены. */
export async function writeSubtitleFiles(
  segments: Segment[],
  input: string,
  targetDir: string,
  options: SubtitleOptions = DEFAULT_SUBTITLE_OPTIONS,
  sourceLanguage = 'en',
): Promise<SubtitleResult> {
  const warnings: StageWarning[] = [];
  const files: SubtitleResult['files'] = [];
  await mkdir(targetDir, { recursive: true });

  // Оригинал — на языке записи, перевод — всегда русский; правила читаемости
  // у них разные, поэтому опции берутся под каждый язык отдельно.
  //
  // Время у них тоже разное. Оригинал стоит на исходных таймкодах, а перевод
  // идёт вместе с озвучкой: укладка вправе сдвинуть реплику (по умолчанию до
  // полутора секунд), и русская строка обязана ехать за русским голосом, а не
  // оставаться там, где говорили на языке оригинала.
  const outputs = [
    { kind: 'source' as const, code: sourceLanguage, text: (segment: Segment) => segment.text_en, shifted: false },
    { kind: 'target' as const, code: 'ru', text: (segment: Segment) => segment.text_ru, shifted: true },
  ];

  for (const output of outputs) {
    const items = segments
      .map((segment) => {
        const shift = output.shifted ? (segment.shift_ms ?? 0) / 1000 : 0;
        return {
          id: segment.id,
          start: segment.start + shift,
          end: segment.end + shift,
          text: output.text(segment) ?? '',
        };
      })
      .filter((item) => item.text.trim().length > 0);

    if (items.length === 0) {
      if (output.kind === 'target') warnings.push(warn('warn.subs.notTranslated', 'Русские субтитры не созданы: реплики ещё не переведены'));
      continue;
    }

    const cues = planCues(items, optionsForLanguage(options, output.code));
    const target = path.join(targetDir, subtitleFileName(input, output.code));
    // BOM: Windows-проигрыватели иначе показывают кириллицу как «кракозябры».
    await writeFile(target, `﻿${formatSrt(cues)}`, 'utf8');
    files.push({ lang: output.code, kind: output.kind, path: target, cues: cues.length });
    log.step(`субтитры ${output.code}: ${cues.length} титров → ${target}`);
  }

  return { files, warnings };
}
