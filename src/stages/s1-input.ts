import { existsSync } from 'node:fs';
import path from 'node:path';
import { StageError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { TOOL_VERSION, type Workspace } from '../core/workspace.js';
import type { Meta } from '../core/types.js';
import { isUrl } from '../util/hash.js';
import { run } from '../util/exec.js';
import { requireTool } from '../util/tools.js';
import { extractAnalysisAudio, extractOriginalAudio, probeMedia } from '../util/ffmpeg.js';

/**
 * S1 — input intake and audio extraction (SPEC FR-1).
 * Produces: source media (for URLs), audio.wav (mono 48k), original.wav, meta.json.
 */

export interface S1Result {
  meta: Meta;
  sourcePath: string;
  analysisAudio: string;
  originalAudio: string;
  warnings: string[];
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
  const warnings: string[] = [];

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
    warnings.push('Во входе нет видеопотока — итог будет сохранён как .m4a (ТЗ FR-7)');
  }
  if (info.durationSeconds > 3 * 3600) {
    warnings.push(
      `Длительность ${(info.durationSeconds / 3600).toFixed(1)} ч — обработка займёт часы (ТЗ §8)`,
    );
  }

  const analysisAudio = workspace.file('audio.wav');
  const originalAudio = workspace.file('original.wav');

  log.step('Извлечение аудио (48 кГц, моно, 16 бит)');
  log.progress('извлечение аудио из видео', null);
  await extractAnalysisAudio(sourcePath, analysisAudio, workspace.toolsDir);
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
