import { describe, it, expect } from 'vitest';
import { intakeVerdict } from '../src/stages/s1-input.js';

/**
 * Настоящий случай, ради которого сверка и появилась: серия объявляла 28 минут,
 * а декодировалась на 7.6 — и конвейер молча дублировал четверть фильма.
 */
describe('FR-1: полнота извлечённого аудио', () => {
  it('недокачанная серия не проходит дальше', () => {
    const verdict = intakeVerdict(28 * 60, 7.6 * 60);
    expect(verdict.kind).toBe('broken');
    if (verdict.kind !== 'ok') expect(Math.round(verdict.share * 100)).toBe(73);
  });

  it('округление последнего кадра поводом не считается', () => {
    expect(intakeVerdict(908.5, 908.4).kind).toBe('ok');
    expect(intakeVerdict(908.5, 907.6).kind).toBe('ok');
  });

  it('заметная, но не катастрофическая недостача — предупреждение', () => {
    const verdict = intakeVerdict(600, 570);
    expect(verdict.kind).toBe('warn');
    if (verdict.kind !== 'ok') expect(verdict.missingSeconds).toBeCloseTo(30, 5);
  });

  it('порог в процентах, а не в секундах: час с минутой недостачи — предупреждение', () => {
    // 60 с на часовом фильме — это 1.7%, значимо; на десятиминутном — 10%.
    expect(intakeVerdict(3600, 3540).kind).toBe('warn');
    expect(intakeVerdict(600, 540).kind).toBe('warn');
  });

  it('звук длиннее контейнера претензией не считается', () => {
    expect(intakeVerdict(600, 601).kind).toBe('ok');
  });

  it('без длительности контейнера судить не о чем', () => {
    expect(intakeVerdict(0, 0).kind).toBe('ok');
    expect(intakeVerdict(-1, 10).kind).toBe('ok');
  });
});
