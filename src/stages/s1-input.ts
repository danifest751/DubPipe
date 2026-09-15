import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DubConfig } from '../config/schema.js';
import { StageError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { TOOL_VERSION, type Workspace } from '../core/workspace.js';
import { warn, type Meta, type StageWarning } from '../core/types.js';
import { isUrl } from '../util/hash.js';
import { extractAnalysisAudio, extractOriginalAudio, probeMedia } from '../util/ffmpeg.js';
import { downloadYt, resolveYt } from '../util/ytdlp.js';
import { wavDuration } from '../util/wav.js';

/**
 * S1 — input intake and audio extraction (SPEC FR-1).
 * Produces: source media (for URLs), audio.wav (mono 48k), original.wav, meta.json.
 */

/**
 * Вход, на котором стоит переспросить: обработка займёт часы, а перевод — денег.
 *
 * Порог один на всё: и предупреждение стадии, и вопрос в консоли считают
 * «длинным» одно и то же. Два числа разошлись бы в первый же раз, когда одно
 * из них поправят.
 */
export const LONG_INPUT_SECONDS = 3 * 3600;

/**
 * Сколько звука недосчитались против того, что обещает контейнер.
 *
 * Реальный случай: недокачанная серия объявляла 28 минут, а декодировалась на
 * 7.6 — потерянные пакеты обрывали поток. Конвейер этого не замечал и уверенно
 * дублировал четверть фильма; узнать об этом можно было, только посмотрев
 * результат. Поэтому длительность извлечённого звука сверяется с заявленной.
 *
 * Небольшое расхождение — норма: у контейнера и у звуковой дорожки разные
 * длительности, последний кадр округляется. Значимым считается пропуск больше
 * секунды и больше процента; больше четверти — это уже не округление, а
 * оборванный файл, и продолжать бессмысленно.
 */
export type IntakeVerdict = { kind: 'ok' } | { kind: 'warn' | 'broken'; missingSeconds: number; share: number };

export function intakeVerdict(containerSeconds: number, extractedSeconds: number): IntakeVerdict {
  if (!(containerSeconds > 0) || !(extractedSeconds >= 0)) return { kind: 'ok' };
  const missingSeconds = containerSeconds - extractedSeconds;
  const share = missingSeconds / containerSeconds;
  if (missingSeconds <= 1 || share <= 0.01) return { kind: 'ok' };
  return { kind: share > 0.25 ? 'broken' : 'warn', missingSeconds, share };
}

export interface S1Result {
  meta: Meta;
  sourcePath: string;
  analysisAudio: string;
  originalAudio: string;
  warnings: StageWarning[];
}

/**
 * Скачивание ссылки в рабочую папку.
 *
 * Файл кладётся рядом с будущим дубляжем, а не в кэш: он нужен человеку и после
 * прогона — посмотреть, перезапустить стадии, отдать другому инструменту. Раньше
 * он лежал в `.dubpipe/<hash>/source.mp4` и исчезал вместе с очисткой кэша.
 *
 * Прежде чем качать, ссылка разбирается: название, длительность и размер
 * попадают в журнал, а прямой эфир отсекается сразу — его нельзя скачать целиком,
 * и узнать об этом лучше до, а не после.
 */
async function downloadFromUrl(
  input: string,
  workspace: Workspace,
  config: DubConfig,
  downloadDir: string,
): Promise<{ file: string; warnings: StageWarning[] }> {
  const warnings: StageWarning[] = [];
  const quality = config.download.quality;
  const info = await resolveYt(input, workspace.toolsDir, quality);

  if (info.isLive) {
    throw new StageError('s1', 'Это прямой эфир — скачать его целиком нельзя', {
      hints: ['Дождитесь окончания трансляции и повторите'],
    });
  }

  const minutes = info.durationSeconds ? Math.round(info.durationSeconds / 60) : null;
  const size = info.bytes ? `, около ${(info.bytes / 1024 ** 2).toFixed(0)} МБ` : '';
  log.step(`Загрузка: ${info.title}${minutes ? ` (${minutes} мин${size})` : ''}`);

  /*
   * Плейлист в режиме «спросить» обрабатывается как один ролик, но молчать об
   * этом нельзя: раньше `--no-playlist` прятал остальные двадцать видео, и
   * человек узнавал об этом только по названию скачанного файла.
   */
  const wholePlaylist = config.download.playlist === 'all';
  if (info.isPlaylist && !wholePlaylist) {
    warnings.push(
      warn(
        'warn.s1.playlist',
        `Это плейлист из ${info.entries.length} видео — обрабатываю первое. ` +
          'Весь список: download.playlist: all в config.yaml',
        { count: info.entries.length },
      ),
    );
  }

  const files = await downloadYt(info.url || input, downloadDir, workspace.toolsDir, {
    quality,
    container: config.download.container,
    filenameTemplate: config.download.filename_template,
    cookiesFromBrowser: config.download.cookies_from_browser,
    cookiesFile: config.download.cookies_file,
    writeThumbnail: config.download.write_thumbnail,
    writeSubtitles: config.download.write_subtitles,
    subtitleLanguages: config.download.subtitle_languages,
    concurrentFragments: config.download.concurrent_fragments,
    expectedBytes: info.bytes,
    videoId: info.id,
    label: info.title,
    ...(wholePlaylist ? { playlist: true } : {}),
  });

  if (files.length > 1) {
    warnings.push(
      warn('warn.s1.playlistDownloaded', `Скачано файлов: ${files.length} — дублирую первый, остальные лежат рядом`, {
        count: files.length,
      }),
    );
  }

  return { file: files[0]!, warnings };
}

export interface S1Options {
  /** Куда положить скачанное по ссылке; без него — в кэш, как было раньше. */
  downloadDir?: string;
}

export async function runS1(
  workspace: Workspace,
  input: string,
  config: DubConfig,
  options: S1Options = {},
): Promise<S1Result> {
  const warnings: StageWarning[] = [];

  let sourcePath: string;
  if (isUrl(input)) {
    const downloaded = await downloadFromUrl(input, workspace, config, options.downloadDir ?? workspace.dir);
    warnings.push(...downloaded.warnings);
    sourcePath = downloaded.file;
  } else {
    sourcePath = path.resolve(input);
  }
  if (!existsSync(sourcePath)) {
    throw new StageError('s1', `Входной файл не найден: ${sourcePath}`, {
      hints: ['Укажите существующий файл или YouTube-URL'],
    });
  }

  const info = await probeMedia(sourcePath, workspace.toolsDir);
  if (!info.hasAudio) {
    throw new StageError('s1', 'Во входном файле нет аудиодорожки', { artifact: sourcePath });
  }
  if (!info.hasVideo) {
    warnings.push(warn('warn.s1.noVideo', 'Во входе нет видеопотока — итог будет сохранён как .m4a (ТЗ FR-7)'));
  }
  if (info.durationSeconds > LONG_INPUT_SECONDS) {
    const hours = (info.durationSeconds / 3600).toFixed(1);
    warnings.push(warn('warn.s1.long', `Длительность ${hours} ч — обработка займёт часы (ТЗ §8)`, { hours }));
  }

  const analysisAudio = workspace.file('audio.wav');
  const originalAudio = workspace.file('original.wav');

  log.step('Извлечение аудио (48 кГц, моно, 16 бит)');
  log.progress('извлечение аудио из видео', null, null, { key: 'work.extract' });
  await extractAnalysisAudio(sourcePath, analysisAudio, workspace.toolsDir);
  // Сверка полноты входа: см. intakeVerdict.
  const verdict = intakeVerdict(info.durationSeconds, await wavDuration(analysisAudio));
  if (verdict.kind !== 'ok') {
    const lost = `${verdict.missingSeconds.toFixed(1)} с из ${info.durationSeconds.toFixed(1)} ` +
      `(${(verdict.share * 100).toFixed(0)}%)`;
    if (verdict.kind === 'broken') {
      throw new StageError('s1', `Из файла извлеклось не всё аудио: не хватает ${lost}`, {
        artifact: sourcePath,
        hints: [
          'Похоже, файл скачан не полностью или повреждён — проверьте его проигрывателем',
          'Скачайте файл заново и повторите',
        ],
      });
    }
    warnings.push(
      warn(
        'warn.s1.short',
        `Извлечённое аудио короче заявленной длительности на ${lost} — ` +
          'возможно, файл повреждён; конец фильма может остаться без дубляжа',
        { lost },
      ),
    );
  }

  log.step('Сохранение копии оригинала для сведения');
  await extractOriginalAudio(sourcePath, originalAudio, workspace.toolsDir);

  const meta: Meta = {
    input,
    input_hash: workspace.inputHash,
    duration_seconds: Number(info.durationSeconds.toFixed(3)),
    created_at: new Date().toISOString(),
    tool_version: TOOL_VERSION,
    has_video: info.hasVideo,
    stage_fingerprints: {},
  };
  await workspace.writeMeta(meta);

  return { meta, sourcePath, analysisAudio, originalAudio, warnings };
}
