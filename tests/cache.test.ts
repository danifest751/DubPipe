import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { computeFingerprints } from '../src/core/workspace.js';
import {
  stageRange,
  disabledStages,
  effectiveConfig,
  needsSpeakers,
  stageComplete,
  stageInputHash,
} from '../src/core/pipeline.js';
import { makeSegment, STAGE_IDS, type Segment } from '../src/core/types.js';

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

describe('FR-8: диаризация только там, где нужны голоса', () => {
  const stages = (...ids: string[]) => ids as Parameters<typeof needsSpeakers>[0];

  it('спикеры нужны, только если в прогоне есть озвучка', () => {
    expect(needsSpeakers(stages('s1', 's2', 's3'))).toBe(false);
    expect(needsSpeakers(stages('s1', 's2', 's3', 's5', 's6', 's7'))).toBe(true);
    expect(needsSpeakers(stages('s5'))).toBe(true);
    expect(needsSpeakers(stages())).toBe(false);
  });

  it('без озвучки диаризация выключается, исходная конфигурация не меняется', () => {
    const config = baseConfig();
    expect(config.asr.diarization.enabled).toBe(true);

    const forSubtitles = effectiveConfig(config, stages('s1', 's2', 's3'));
    expect(forSubtitles.asr.diarization.enabled).toBe(false);
    expect(config.asr.diarization.enabled).toBe(true);
    // Остальные настройки распознавания не тронуты.
    expect(forSubtitles.asr.model).toBe(config.asr.model);
    expect(forSubtitles.asr.vad.enabled).toBe(config.asr.vad.enabled);
  });

  it('с озвучкой конфигурация остаётся прежней', () => {
    const config = baseConfig();
    expect(effectiveConfig(config, stages('s2', 's5'))).toBe(config);
  });

  it('выключенная пользователем диаризация не включается обратно', () => {
    const config = parseConfig({ asr: { diarization: { enabled: false } } }, 'test');
    expect(effectiveConfig(config, stages('s2', 's5'))).toBe(config);
  });

  it('отпечаток распознавания без спикеров отличается: кэш субтитров не подменит дубляж', () => {
    const config = baseConfig();
    const withSpeakers = computeFingerprints(config, 'hash-1');
    const withoutSpeakers = computeFingerprints(effectiveConfig(config, stages('s1', 's2', 's3')), 'hash-1');
    expect(withoutSpeakers['s2']).not.toBe(withSpeakers['s2']);
  });
});

describe('§6: продолжение прогона с середины', () => {
  const always = () => true;
  const segment = (id: number, fields: Partial<Segment> = {}): Segment =>
    makeSegment({ id, start: id, end: id + 1, text_en: 'line', ...fields });

  it('перевод считается сделанным, даже если отдельная реплика не переведена', () => {
    // Междометие, на котором сорвался перевод: русского текста у него нет и не
    // будет. Остальные триста реплик переведены — работа стадии сделана.
    const segments = [segment(0, { text_ru: 'первая' }), segment(1, { text_ru: null })];
    expect(stageComplete('s3', segments, always)).toBe(true);
  });

  it('без единого перевода стадия не сделана', () => {
    expect(stageComplete('s3', [segment(0), segment(1)], always)).toBe(false);
    expect(stageComplete('s3', [], always)).toBe(false);
  });

  it('синтез спрашивают только с переведённых реплик', () => {
    const segments = [
      segment(0, { text_ru: 'первая', tts_file: 'tts/0000.wav' }),
      segment(1, { text_ru: null }),
    ];
    expect(stageComplete('s5', segments, always)).toBe(true);

    segments[0]!.tts_file = null;
    expect(stageComplete('s5', segments, always)).toBe(false);
  });

  it('пропавший на диске файл синтеза возвращает стадию в работу', () => {
    const segments = [segment(0, { text_ru: 'первая', tts_file: 'tts/0000.wav' })];
    expect(stageComplete('s5', segments, () => false)).toBe(false);
  });

  it('подгонку спрашивают только с озвученных реплик', () => {
    const segments = [
      segment(0, { text_ru: 'первая', tts_file: 'tts/0000.wav', aligned_file: 'aligned/0000.wav' }),
      segment(1, { text_ru: null }),
    ];
    expect(stageComplete('s6', segments, always)).toBe(true);

    segments[0]!.aligned_file = null;
    expect(stageComplete('s6', segments, always)).toBe(false);
  });
});

describe('§7: свежесть по тому, из чего стадия работает', () => {
  const voiced = (id: number, text: string | null, file: string | null, duration: number | null): Segment =>
    makeSegment({ id, start: id, end: id + 1, text_en: 'line', text_ru: text, tts_file: file, tts_duration: duration });

  it('другой перевод делает синтез несвежим', () => {
    // Иначе повторный перевод оставит озвучку от прежнего текста: субтитры
    // обновятся, звук нет, и заметить это можно будет только на слух.
    const before = [voiced(0, 'первая', 'tts/0.wav', 1)];
    const after = [voiced(0, 'первая, но иначе', 'tts/0.wav', 1)];
    expect(stageInputHash('s5', before)).not.toBe(stageInputHash('s5', after));
  });

  it('тот же перевод оставляет синтез свежим', () => {
    const a = [voiced(0, 'первая', 'tts/0.wav', 1)];
    const b = [voiced(0, 'первая', 'tts/0.wav', 2)];
    // Длительность синтеза на свежесть синтеза не влияет — влияет текст.
    expect(stageInputHash('s5', a)).toBe(stageInputHash('s5', b));
  });

  it('другой синтез делает укладку несвежей', () => {
    const a = [voiced(0, 'первая', 'tts/0.wav', 1)];
    const b = [voiced(0, 'первая', 'tts/0.wav', 1.4)];
    expect(stageInputHash('s6', a)).not.toBe(stageInputHash('s6', b));
  });

  it('стадии, зависящие только от настроек, содержимое не сверяют', () => {
    for (const stage of ['s1', 's2', 's3', 's4', 's7'] as const) {
      expect(stageInputHash(stage, [voiced(0, 'текст', null, null)])).toBeNull();
    }
  });
});
