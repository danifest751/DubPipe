import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileMetadataArgs } from '../src/stages/s7-mix.js';

/**
 * Теги итогового файла (SPEC FR-7).
 *
 * Источник с тегами передаёт их дублю сам — ffmpeg без `-map_metadata` копирует
 * глобальные метаданные первого входа, — поэтому S7 дописывает только то, что
 * отличает перевод от оригинала: иначе дубляж выглядел бы в плеере копией
 * исходника.
 *
 * Пути собираются через `path.join`, а не пишутся как `C:\…`: тесты идут и на
 * Linux, где обратный слэш — обычный символ, и литеральный Windows-путь там не
 * разбирается на части. На этом CI уже падал.
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
    const file = path.join('videos', 'lecture.mp4');
    expect(fileMetadataArgs({ input: file, source_path: file })).toEqual(['-metadata', 'title=lecture (RU)']);
  });

  it('старым рабочим каталогам названия хватает из пути', () => {
    // Поля source_title там нет: оно появилось вместе с тегами.
    const cached = path.join('videos', 'Ролик [dQw4w9WgXcQ].mp4');
    const args = fileMetadataArgs({ input: 'https://youtu.be/id', source_path: cached });
    expect(args).toContain('title=Ролик [dQw4w9WgXcQ] (RU)');
  });

  it('без ссылки на источник comment не выдумывается', () => {
    const args = fileMetadataArgs({ input: path.join('videos', 'a.mp4'), source_title: 'Фильм' });
    expect(args.join(' ')).not.toContain('comment=');
  });

  it('если названия нет вовсе, тег не ставится', () => {
    expect(fileMetadataArgs({ input: 'https://youtu.be/id' })).toEqual(['-metadata', 'comment=https://youtu.be/id']);
  });
});
