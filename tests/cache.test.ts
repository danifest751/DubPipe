import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { computeFingerprints } from '../src/core/workspace.js';
import { stageRange, disabledStages } from '../src/core/pipeline.js';
import { STAGE_IDS } from '../src/core/types.js';

const baseConfig = () => parseConfig({}, 'test');

describe('§7: ключи кэша стадий', () => {
  it('одинаковый вход и конфиг дают одинаковые отпечатки', () => {
    const a = computeFingerprints(baseConfig(), 'hash-1');
    const b = computeFingerprints(baseConfig(), 'hash-1');
    expect(a).toEqual(b);
  });

  it('другой вход меняет отпечатки всех стадий', () => {
    const a = computeFingerprints(baseConfig(), 'hash-1');
    const b = computeFingerprints(baseConfig(), 'hash-2');
    for (const stage of STAGE_IDS) expect(a[stage]).not.toBe(b[stage]);
  });

  it('изменение настроек ранней стадии инвалидирует все последующие', () => {
    const before = computeFingerprints(baseConfig(), 'hash-1');
    const after = computeFingerprints(parseConfig({ asr: { model: 'medium' } }, 'test'), 'hash-1');

    expect(after['s1']).toBe(before['s1']); // S1 не зависит от настроек ASR
    for (const stage of ['s2', 's3', 's4', 's5', 's6', 's7'] as const) {
      expect(after[stage]).not.toBe(before[stage]);
    }
  });

  it('изменение настроек поздней стадии не трогает ранние', () => {
    const before = computeFingerprints(baseConfig(), 'hash-1');
    const after = computeFingerprints(parseConfig({ mix: { voice_gain_db: -3 } }, 'test'), 'hash-1');

    for (const stage of ['s1', 's2', 's3', 's4', 's5', 's6'] as const) {
      expect(after[stage]).toBe(before[stage]);
    }
    expect(after['s7']).not.toBe(before['s7']);
  });
});

describe('§2, §6: диапазон стадий', () => {
  it('по умолчанию проходит весь конвейер', () => {
    expect(stageRange()).toEqual([...STAGE_IDS]);
  });

  it('ограничивает диапазон с обеих сторон', () => {
    expect(stageRange('s2', 's5')).toEqual(['s2', 's3', 's4', 's5']);
  });

  it('отвергает перевёрнутый диапазон', () => {
    expect(() => stageRange('s5', 's2')).toThrow(/после/);
  });

  it('отключает только необязательные стадии', () => {
    const disabled = disabledStages(parseConfig({ separation: { enabled: false }, alignment: { enabled: false } }, 'test'));
    expect([...disabled].sort()).toEqual(['s4', 's6']);
  });

  it('не позволяет отключить обязательные стадии', () => {
    const disabled = disabledStages(parseConfig({ separation: { enabled: true }, alignment: { enabled: true } }, 'test'));
    expect(disabled.size).toBe(0);
  });
});
