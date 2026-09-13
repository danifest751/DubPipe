import { describe, it, expect } from 'vitest';
import {
  ConfigError,
  DubPipeError,
  EXIT,
  MissingDependencyError,
  StageError,
  toExitCode,
} from '../src/core/errors.js';

describe('§7: ошибки называют стадию и проблемный артефакт', () => {
  it('подставляет имя стадии в сообщение', () => {
    const error = new StageError('s2', 'модель не отвечает');
    expect(error.message).toBe('[s2] модель не отвечает');
  });

  it('подставляет путь артефакта', () => {
    const error = new StageError('s3', 'битый файл', { artifact: 'C:/work/segments.json' });
    expect(error.message).toBe('[s3] битый файл (артефакт: C:/work/segments.json)');
    expect(error.artifact).toBe('C:/work/segments.json');
  });

  it('сохраняет подсказки и первопричину', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new StageError('s3', 'нет связи', { hints: ['проверьте ключ'], cause });
    expect(error.hints).toEqual(['проверьте ключ']);
    expect(error.cause).toBe(cause);
  });
});

describe('§6: коды возврата', () => {
  it('различает типы ошибок', () => {
    expect(toExitCode(new StageError('s1', 'x'))).toBe(EXIT.STAGE_ERROR);
    expect(toExitCode(new ConfigError('x'))).toBe(EXIT.CONFIG_ERROR);
    expect(toExitCode(new MissingDependencyError('ffmpeg', 'x'))).toBe(EXIT.MISSING_DEPENDENCY);
  });

  it('неизвестную ошибку считает ошибкой стадии', () => {
    expect(toExitCode(new Error('что-то пошло не так'))).toBe(EXIT.STAGE_ERROR);
    expect(toExitCode('строка')).toBe(EXIT.STAGE_ERROR);
  });

  it('все типы наследуются от общего корня', () => {
    expect(new StageError('s1', 'x')).toBeInstanceOf(DubPipeError);
    expect(new ConfigError('x')).toBeInstanceOf(DubPipeError);
    expect(new MissingDependencyError('ffmpeg', 'x')).toBeInstanceOf(DubPipeError);
  });

  it('запоминает имя недостающего инструмента', () => {
    const error = new MissingDependencyError('ffmpeg', 'не найден', ['winget install Gyan.FFmpeg']);
    expect(error.tool).toBe('ffmpeg');
    expect(error.hints).toHaveLength(1);
  });
});
