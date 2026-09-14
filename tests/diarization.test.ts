import { describe, it, expect } from 'vitest';
import {
  assignSpeakers,
  cachedTurns,
  diarizationFingerprint,
  speakerFor,
  speakerNames,
  weightsMarker,
  type DiarizationTurn,
} from '../src/providers/diarization/pyannote.js';
import { makeSegment, type WordTiming } from '../src/core/types.js';
import { parseConfig } from '../src/config/load.js';

const turn = (start: number, end: number, speaker: string): DiarizationTurn => ({ start, end, speaker });
const words = (...items: Array<[string, number, number]>): WordTiming[] =>
  items.map(([word, start, end]) => ({ word, start, end }));

describe('FR-2: имена спикеров', () => {
  it('нумерует спикеров в порядке первого появления', () => {
    const names = speakerNames([turn(5, 6, 'SPEAKER_01'), turn(0, 1, 'SPEAKER_00'), turn(2, 3, 'SPEAKER_07')]);
    expect(names.get('SPEAKER_00')).toBe('speaker_0');
    expect(names.get('SPEAKER_07')).toBe('speaker_1');
    expect(names.get('SPEAKER_01')).toBe('speaker_2');
  });

  it('метка весов не содержит символов, запрещённых в именах файлов', () => {
    expect(weightsMarker('pyannote/speaker-diarization-3.1', '/m')).not.toMatch(/ready-.*\//);
  });
});

describe('FR-2: спикер реплики', () => {
  const turns = [turn(0, 2, 'A'), turn(2, 4, 'B'), turn(10, 12, 'A')];
  const names = speakerNames(turns);

  it('выбирает спикера с наибольшим перекрытием', () => {
    expect(speakerFor({ start: 1.5, end: 3.9 }, turns, names)).toBe('speaker_1');
    expect(speakerFor({ start: 0.1, end: 2.5 }, turns, names)).toBe('speaker_0');
  });

  it('вне ходов берёт ближайший, если он не дальше секунды', () => {
    expect(speakerFor({ start: 4.2, end: 4.8 }, turns, names)).toBe('speaker_1');
    expect(speakerFor({ start: 6, end: 7 }, turns, names)).toBe('speaker_0');
  });
});

describe('FR-2: назначение спикеров и разбиение диалога', () => {
  it('без ходов ничего не меняет', () => {
    const segments = [makeSegment({ id: 0, start: 0, end: 1, text_en: 'Hi' })];
    expect(assignSpeakers(segments, [])).toBe(segments);
  });

  it('помечает реплики разными спикерами', () => {
    const segments = [
      makeSegment({ id: 0, start: 0, end: 1.5, text_en: 'Where are we?' }),
      makeSegment({ id: 1, start: 2, end: 3.5, text_en: 'No idea.' }),
    ];
    const result = assignSpeakers(segments, [turn(0, 1.6, 'S1'), turn(1.9, 3.6, 'S2')]);
    expect(result.map((s) => s.speaker)).toEqual(['speaker_0', 'speaker_1']);
    expect(result.map((s) => s.id)).toEqual([0, 1]);
  });

  it('режет склеенный диалог по смене говорящего на границе слов', () => {
    // whisper склеил «What is that? Wormhole capture.» в одну реплику.
    const segment = makeSegment({
      id: 0,
      start: 30.8,
      end: 34.7,
      text_en: 'What is that? Wormhole capture, gravity lock.',
      words: words(
        ['What', 30.9, 31.1],
        ['is', 31.1, 31.3],
        ['that?', 31.3, 32.1],
        ['Wormhole', 32.3, 32.9],
        ['capture,', 32.9, 33.5],
        ['gravity', 33.5, 34.0],
        ['lock.', 34.0, 34.6],
      ),
    });
    const result = assignSpeakers([segment], [turn(30.8, 32.2, 'A'), turn(32.25, 34.7, 'B')]);
    expect(result).toHaveLength(2);
    expect(result[0]!.text_en).toBe('What is that?');
    expect(result[0]!.speaker).toBe('speaker_0');
    expect(result[0]!.start).toBe(30.8);
    expect(result[0]!.end).toBeCloseTo(32.1, 3);
    expect(result[1]!.text_en).toBe('Wormhole capture, gravity lock.');
    expect(result[1]!.speaker).toBe('speaker_1');
    expect(result[1]!.start).toBeCloseTo(32.3, 3);
    expect(result[1]!.end).toBe(34.7);
    expect(result[1]!.flags).toContain('force_split');
    expect(result.map((s) => s.id)).toEqual([0, 1]);
  });

  it('не режет фразу, которую диаризация пропустила, между соседними ходами', () => {
    // Реальный случай: «Come on, come on, come on» 42.94–44.82 не покрыт ходами;
    // слева ход одного спикера до 43.03, справа другого с 44.45.
    const segment = makeSegment({
      id: 0,
      start: 42.94,
      end: 44.82,
      text_en: 'Come on, come on, come on.',
      words: words(['Come', 42.94, 43.23], ['on,', 43.23, 43.51], ['come', 43.51, 43.8], ['on,', 43.8, 44.08], ['come', 44.08, 44.37], ['on.', 44.37, 44.82]),
    });
    const result = assignSpeakers([segment], [turn(41.476, 43.028, 'A'), turn(44.446, 45.087, 'B')]);
    expect(result).toHaveLength(1);
    expect(result[0]!.text_en).toBe('Come on, come on, come on.');
  });

  it('не режет реплику из-за одного слова, отнесённого к другому спикеру', () => {
    const segment = makeSegment({
      id: 0,
      start: 0,
      end: 3,
      text_en: 'We need to leave right now.',
      words: words(['We', 0.1, 0.3], ['need', 0.3, 0.5], ['to', 0.5, 0.6], ['leave', 0.6, 1.0], ['right', 1.0, 1.4], ['now.', 1.4, 2.9]),
    });
    // Диаризация на мгновение «увидела» второго спикера посреди фразы.
    const result = assignSpeakers([segment], [turn(0, 0.55, 'A'), turn(0.55, 0.65, 'B'), turn(0.65, 3, 'A')]);
    expect(result).toHaveLength(1);
    expect(result[0]!.speaker).toBe('speaker_0');
    expect(result[0]!.text_en).toBe('We need to leave right now.');
  });
});

describe('Настройки диаризации', () => {
  it('принимает старое имя движка pyannote-onnx', () => {
    const config = parseConfig({ asr: { diarization: { engine: 'pyannote-onnx' } } }, 'тест');
    expect(config.asr.diarization.engine).toBe('pyannote-onnx');
    expect(config.asr.diarization.hf_token_env).toBe('HF_TOKEN');
  });

  it('не даёт вписать сам токен вместо имени переменной', () => {
    expect(() => parseConfig({ asr: { diarization: { hf_token_env: 'MY_HF_TOKEN' } } }, 'тест')).not.toThrow();
    // Настоящий токен HF состоит из букв и цифр и проходит проверку «похоже на имя переменной».
    expect(() => parseConfig({ asr: { diarization: { hf_token_env: 'hf_' + 'Ab1'.repeat(12) } } }, 'тест')).toThrow(/имя переменной/);
    expect(() => parseConfig({ asr: { diarization: { hf_token_env: 'hf_abc-def' } } }, 'тест')).toThrow(/имя переменной/);
  });
});

describe('Кэш разбора по говорящим', () => {
  const fingerprint = diarizationFingerprint('hash-1', 'speaker-diarization-community-1', 8);
  const turns = [{ start: 0, end: 2, speaker: 'SPEAKER_00' }];

  it('отпечаток не зависит от модели распознавания, но зависит от звука и настроек', () => {
    // Смысл кэша: сменили модель распознавания — разбор по голосам переиспользуется.
    expect(diarizationFingerprint('hash-1', 'speaker-diarization-community-1', 8)).toBe(fingerprint);
    expect(diarizationFingerprint('hash-2', 'speaker-diarization-community-1', 8)).not.toBe(fingerprint);
    expect(diarizationFingerprint('hash-1', 'speaker-diarization-3.1', 8)).not.toBe(fingerprint);
    expect(diarizationFingerprint('hash-1', 'speaker-diarization-community-1', 4)).not.toBe(fingerprint);
  });

  it('берёт реплики из файла с тем же отпечатком', () => {
    expect(cachedTurns({ fingerprint, turns }, fingerprint)).toEqual(turns);
  });

  it('чужой или отсутствующий отпечаток не принимается', () => {
    expect(cachedTurns({ fingerprint: 'другой', turns }, fingerprint)).toBeNull();
    // Файл от старой версии: отпечатка нет, доказать происхождение нечем.
    expect(cachedTurns({ turns }, fingerprint)).toBeNull();
    expect(cachedTurns(null, fingerprint)).toBeNull();
  });

  it('пустой и испорченный разбор считается отсутствующим', () => {
    expect(cachedTurns({ fingerprint, turns: [] }, fingerprint)).toBeNull();
    expect(cachedTurns({ fingerprint, turns: [{ start: 2, end: 1, speaker: 'A' }] }, fingerprint)).toBeNull();
    expect(cachedTurns({ fingerprint, turns: [{ start: 0, end: 1 }] }, fingerprint)).toBeNull();
  });
});
