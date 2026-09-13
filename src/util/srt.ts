import type { Segment } from '../core/types.js';

/** SRT export for manual review of S2/S3 output (SPEC FR-2, §6). */

export function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const ms = Math.round((clamped % 1) * 1000);
  const total = Math.floor(clamped);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
}

export function toSrt(segments: Segment[], lang: 'en' | 'ru' = 'en'): string {
  return segments
    .map((segment, index) => {
      const text = (lang === 'ru' ? segment.text_ru : segment.text_en) ?? '';
      const speaker = segment.speaker !== 'speaker_0' ? `[${segment.speaker}] ` : '';
      return `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${speaker}${text}\n`;
    })
    .join('\n');
}
