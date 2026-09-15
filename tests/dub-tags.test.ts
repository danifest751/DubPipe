import { describe, it, expect } from 'vitest';
import { fileMetadataArgs } from '../src/stages/s7-mix.js';

/**
 * Теги итогового файла (SPEC FR-7).
 *
 * Источник с тегами передаёт их дублю сам — ffmpeg без `-map_metadata` копирует
 * глобальные метаданные первого входа, — поэтому S7 дописывает только то, что
 * отличает перевод от оригинала: иначе дубляж выглядел бы в плеере копией
 * исходника.
 */
describe('§FR-7: теги дубляжа', () => {
  it('называет итог по названию оригинала', () => {
    expect(fileMetadataArgs({ input: 'https://youtu.be/id', source_title: 'Лекция про сжатие' })).toEqual([
      '-metadata',
      'title=Лекция про сжатие (RU)',
      '-metadata',
      'comment=https://youtu.be/id',
    ]);
  });

  it('для локального файла берёт название из имени', () => {
    const args = fileMetadataArgs({
      input: 'C:\\videos\\lecture.mp4',
      source_path: 'C:\\videos\\lecture.mp4',
    });
    expect(args).toEqual(['-metadata', 'title=lecture (RU)']);
  });

  it('старым рабочим каталогам названия хватает из пути', () => {
    // Поля source_title там нет: оно появилось вместе с тегами.
    const args = fileMetadataArgs({
      input: 'https://youtu.be/id',
      source_path: 'C:\\videos\\Ролик [dQw4w9WgXcQ].mp4',
    });
    expect(args).toContain('title=Ролик [dQw4w9WgXcQ] (RU)');
  });

  it('без ссылки на источник comment не выдумывается', () => {
    const args = fileMetadataArgs({ input: 'C:\\videos\\a.mp4', source_title: 'Фильм' });
    expect(args.join(' ')).not.toContain('comment=');
  });

  it('если названия нет вовсе, тег не ставится', () => {
    expect(fileMetadataArgs({ input: 'https://youtu.be/id' })).toEqual(['-metadata', 'comment=https://youtu.be/id']);
  });
});
