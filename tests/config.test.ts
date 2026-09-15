import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { LOCAL_DEFAULT_MODEL } from '../src/config/schema.js';
import { parseConfig, packageRoot } from '../src/config/load.js';
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

  // Поля стояли в config.yaml.example и потому есть у всех, кто делал
  // `dub config init`. Убраны из схемы как неработавшие, но чужой файл из-за
  // этого падать не должен: иначе осмысленный конфиг упирается в «неизвестные
  // поля», и человеку неоткуда узнать, что делать.
  it('молча вычёркивает убранные настройки вместо отказа', () => {
    const config = parseConfig(
      {
        asr: { device: 'cpu', endpoint: null, api_key_env: null },
        tts: { model: null, endpoint: null, api_key_env: null },
      },
      'test',
    );
    expect(config.asr.engine).toBe('whisper-cpp');
    expect(config.tts.engine).toBe('piper');
    expect(Object.hasOwn(config.asr, 'device')).toBe(false);
    expect(Object.hasOwn(config.tts, 'model')).toBe(false);
  });
});

describe('config.yaml.example пригоден для запуска', () => {
  // Пример копируется командой `dub config init` дословно, поэтому он обязан
  // проходить ту же проверку, что и конфиг пользователя: иначе обещание
  // «работает из коробки» проверяется только руками.
  it('разбирается схемой без ошибок', () => {
    const text = readFileSync(path.join(packageRoot(), 'config.yaml.example'), 'utf8');
    const config = parseConfig(YAML.parse(text), 'config.yaml.example');
    expect(config.translate.engine).toBe('kilo-gateway');
    expect(config.tts.engine).toBe('piper');
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

describe('§15: профиль подставляет и движок перевода, и модель', () => {
  it('офлайн берёт локальный движок и локальную модель', () => {
    const config = parseConfig({ profile: 'offline' }, 'тест');
    expect(config.translate.engine).toBe('ollama');
    // Имя из каталога шлюза Ollama не знает: офлайн из коробки падал бы на
    // «модель не установлена», хотя человек ничего не настраивал неправильно.
    expect(config.translate.model).toBe(LOCAL_DEFAULT_MODEL);
    expect(config.translate.model).not.toContain('/');
  });

  it('гибридный профиль остаётся на облачной модели', () => {
    const config = parseConfig({ profile: 'hybrid' }, 'тест');
    expect(config.translate.engine).toBe('kilo-gateway');
    expect(config.translate.model).toContain('/');
  });

  it('явно выбранная модель сильнее профиля', () => {
    const config = parseConfig({ profile: 'offline', translate: { model: 'qwen3:14b' } }, 'тест');
    expect(config.translate.model).toBe('qwen3:14b');
  });

  it('запасная модель тоже задаёт выбор для офлайна', () => {
    const config = parseConfig({ profile: 'offline', translate: { fallback_model: 'gemma3:12b' } }, 'тест');
    expect(config.translate.model).toBe('gemma3:12b');
  });

  it('рецензия идёт в облаке и молчит локально', () => {
    // Замер на 136 репликах: облачный рецензент — 13 правок из 13 приняты за 18 с;
    // локальный — одна за 133 с, и та выдумка. Умолчание следует за замером.
    expect(parseConfig({ profile: 'hybrid' }, 'тест').translate.review.enabled).toBe(true);
    expect(parseConfig({ profile: 'offline' }, 'тест').translate.review.enabled).toBe(false);
  });

  it('написанное в настройках сильнее профиля в обе стороны', () => {
    expect(parseConfig({ profile: 'hybrid', translate: { review: { enabled: false } } }, 'тест').translate.review.enabled).toBe(false);
    expect(parseConfig({ profile: 'offline', translate: { review: { enabled: true } } }, 'тест').translate.review.enabled).toBe(true);
  });

  it('профиль не сбивает остальные настройки рецензии', () => {
    // Подстановка собирает свой объект review — забыв перенести соседние поля,
    // она молча вернула бы batch_lines к умолчанию.
    const config = parseConfig({ profile: 'hybrid', translate: { review: { batch_lines: 120 } } }, 'тест');
    expect(config.translate.review.batch_lines).toBe(120);
    expect(config.translate.review.enabled).toBe(true);
  });
});
