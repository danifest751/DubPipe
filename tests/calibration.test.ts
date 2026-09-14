import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { effectiveCharsPerSecond, usableRate, type Calibration } from '../src/core/calibration.js';

const config = (voice = 'ru_RU-irina-medium') =>
  parseConfig({ tts: { default_voice: voice }, translate: { chars_per_second: 11.5 } }, 'test');

/** Пути в Windows приходят с обратными слэшами; ключи в таблице — с прямыми. */
const toPosix = (value: string) => value.split(String.fromCharCode(92)).join('/');

/** Рабочий каталог понарошку: отдаёт то, что ему положили по этим путям. */
const workspace = (files: Record<string, unknown>) =>
  ({
    root: 'ROOT',
    file: (name: string) => `WS/${name}`,
    readJson: async (path: string) => files[toPosix(path)] ?? null,
  }) as never;

const measured = (rate: number, voice = 'ru_RU-irina-medium'): Calibration => ({
  chars_per_second: rate,
  voice,
  measured_at: '2026-09-14T00:00:00.000Z',
  samples: 100,
});

describe('Темп речи: замер важнее настройки', () => {
  it('берёт замер этой записи', async () => {
    const ws = workspace({ 'WS/calibration.json': measured(13.22) });
    expect(await effectiveCharsPerSecond(ws, config())).toBe(13.22);
  });

  it('без замера этой записи берёт запомненный для голоса', async () => {
    const ws = workspace({ 'ROOT/calibration.json': { 'ru_RU-irina-medium': measured(13.22) } });
    // Так первый же прогон нового видео целится правильно.
    expect(await effectiveCharsPerSecond(ws, config())).toBe(13.22);
  });

  it('замер чужого голоса не подходит', async () => {
    // У каждого голоса свой темп; чужой замер хуже, чем честное умолчание.
    const ws = workspace({
      'WS/calibration.json': measured(13.22, 'ru_RU-denis-medium'),
      'ROOT/calibration.json': { 'ru_RU-denis-medium': measured(13.22, 'ru_RU-denis-medium') },
    });
    expect(await effectiveCharsPerSecond(ws, config())).toBe(11.5);
  });

  it('без замеров остаётся настройка', async () => {
    expect(await effectiveCharsPerSecond(workspace({}), config())).toBe(11.5);
  });

  it('бессмысленный замер не принимается', async () => {
    // Границы человеческой речи: за ними замер — признак сбоя, а не голоса.
    expect(usableRate(13.22)).toBe(true);
    expect(usableRate(0)).toBe(false);
    expect(usableRate(45)).toBe(false);
    expect(usableRate(Number.NaN)).toBe(false);
    expect(usableRate(undefined)).toBe(false);
    const ws = workspace({ 'WS/calibration.json': measured(120) });
    expect(await effectiveCharsPerSecond(ws, config())).toBe(11.5);
  });
});
