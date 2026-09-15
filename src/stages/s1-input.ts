import { existsSync } from 'node:fs';
import path from 'node:path';
import { StageError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { TOOL_VERSION, type Workspace } from '../core/workspace.js';
import { warn, type Meta, type StageWarning } from '../core/types.js';
import { isUrl } from '../util/hash.js';
import { run } from '../util/exec.js';
import { requireTool } from '../util/tools.js';
import { extractAnalysisAudio, extractOriginalAudio, probeMedia } from '../util/ffmpeg.js';
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

async function downloadFromUrl(url: string, workspace: Workspace): Promise<string> {
  const ytDlp = await requireTool('yt-dlp', workspace.toolsDir);
  const ffmpegDir = path.dirname(await requireTool('ffmpeg', workspace.toolsDir));
  const target = workspace.file('source.%(ext)s');

  log.step(`Загрузка исходного видео: ${url}`);
  await run(
    ytDlp,
    [
      '--no-playlist',
      '--no-progress',
      '--ffmpeg-location',
      ffmpegDir,
      '-f',
      'bv*+ba/b',
      '--merge-output-format',
      'mp4',
      '-o',
      target,
      url,
    ],
    { timeoutMs: 3_600_000, onStderr: (chunk) => log.debug(chunk.trim()) },
  );

  for (const ext of ['mp4', 'mkv', 'webm', 'm4a', 'mp3', 'opus']) {
    const candidate = workspace.file(`source.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  throw new StageError('s1', 'yt-dlp завершился успешно, но файл не найден', { artifact: workspace.dir });
}

export async function runS1(workspace: Workspace, input: string): Promise<S1Result> {
  const warnings: StageWarning[] = [];

  const sourcePath = isUrl(input) ? await downloadFromUrl(input, workspace) : path.resolve(input);
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
