import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { ConfigError } from '../src/core/errors.js';

describe('§5.3: валидация конфигурации', () => {
  it('пустой конфиг даёт рабочие значения по умолчанию', () => {
    const config = parseConfig({}, 'test');
    expect(config.profile).toBe('hybrid');
    expect(config.asr.engine).toBe('whisper-cpp');
    expect(config.tts.engine).toBe('piper');
    expect(config.translate.engine).toBe('kilo-gateway');
    expect(config.alignment.min_tempo).toBe(0.9);
    expect(config.alignment.max_tempo).toBe(1.25);
    expect(config.mix.duck_db).toBe(-18);
  });

  it('профиль offline переводит S3 на локальный движок', () => {
    const config = parseConfig({ profile: 'offline' }, 'test');
    expect(config.translate.engine).toBe('ollama');
  });

  it('явно заданный движок перевода сильнее профиля', () => {
    const config = parseConfig({ profile: 'offline', translate: { engine: 'kilo-gateway' } }, 'test');
    expect(config.translate.engine).toBe('kilo-gateway');
  });

  it('сообщение об ошибке называет поле и допустимый диапазон', () => {
    try {
      parseConfig({ alignment: { max_tempo: 5 } }, 'test');
      expect.unreachable('ожидалась ошибка конфигурации');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('alignment.max_tempo');
      expect((error as ConfigError).message).toContain('≤ 2');
    }
  });

  it('ловит min_tempo больше max_tempo', () => {
    expect(() => parseConfig({ alignment: { min_tempo: 1, max_tempo: 1 } }, 'test')).not.toThrow();
    try {
      parseConfig({ alignment: { min_tempo: 1, max_tempo: 1 }, translate: { batch_size: 0 } }, 'test');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as ConfigError).message).toContain('translate.batch_size');
    }
  });

  it('отклоняет TTS через Kilo Gateway с объяснением (§3.1.1)', () => {
    try {
      parseConfig({ tts: { engine: 'kilo-gateway' } }, 'test');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as ConfigError).message).toContain('tts.engine');
      expect((error as ConfigError).message).toContain('/audio/speech');
    }
  });

  it('отклоняет ASR через Kilo Gateway: нет таймкодов (§3.1.1)', () => {
    try {
      parseConfig({ asr: { engine: 'kilo-gateway' } }, 'test');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as ConfigError).message).toContain('asr.engine');
      expect((error as ConfigError).message).toContain('таймкоды');
    }
  });

  it('сообщает о неизвестных полях верхнего уровня', () => {
    try {
      parseConfig({ unknown_field: 1 }, 'test');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as ConfigError).message).toContain('unknown_field');
    }
  });

  it('принимает batch_size в диапазоне 1–50', () => {
    expect(parseConfig({ translate: { batch_size: 12 } }, 'test').translate.batch_size).toBe(12);
    expect(() => parseConfig({ translate: { batch_size: 51 } }, 'test')).toThrow(ConfigError);
  });
});

describe('Где считать: один словарь на все стадии', () => {
  // Стадии выбирают устройство независимо, потому что выгода у них разная:
  // тяжёлую сеть видеокарта ускоряет, лёгкую — замедляет. Но слова должны быть
  // одни и те же, иначе человеку приходится помнить, где как называется.
  const DEVICES = ['auto', 'cpu', 'gpu', 'igpu', 'dgpu', 'cuda'] as const;

  it('диаризация и разделение понимают одни и те же значения', () => {
    for (const device of DEVICES) {
      expect(parseConfig({ asr: { diarization: { device } } }, 'test').asr.diarization.device).toBe(device);
      expect(parseConfig({ separation: { device } }, 'test').separation.device).toBe(device);
    }
  });

  it('по умолчанию устройство выбирается само', () => {
    const config = parseConfig({}, 'test');
    expect(config.asr.diarization.device).toBe('auto');
    expect(config.separation.device).toBe('auto');
  });

  it('выдуманное устройство отвергается с понятной ошибкой', () => {
    expect(() => parseConfig({ separation: { device: 'opencl' } }, 'test')).toThrow(ConfigError);
    expect(() => parseConfig({ asr: { diarization: { device: 'npu' } } }, 'test')).toThrow(ConfigError);
  });

  it('сборка whisper — отдельная настройка: это не «где», а «чем»', () => {
    // asr.backend называет сборку программы распознавания, а не устройство:
    // у процессорных сборок их две, и различаются они библиотекой матричных
    // операций, а не наличием видеокарты.
    expect(parseConfig({ asr: { backend: 'vulkan' } }, 'test').asr.backend).toBe('vulkan');
    expect(parseConfig({ asr: { backend: 'blas' } }, 'test').asr.backend).toBe('blas');
    expect(() => parseConfig({ asr: { backend: 'igpu' } }, 'test')).toThrow(ConfigError);
  });
});
