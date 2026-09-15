/**
 * Живая проверка загрузки по ссылке: разбор, прогресс, отмена, повтор.
 *
 * Сеть и yt-dlp здесь неизбежны, поэтому скрипт живёт в `scripts/`, а не в
 * тестах (CONTRIBUTING.md: тесты не ходят в сеть). Запуск:
 *
 *   npx tsx scripts/check-youtube.mts [ссылка]
 *
 * Проверяет ровно то, что нельзя проверить на фикстурах: что разбор отдаёт
 * метаданные, что прогресс приходит числами, что отмена убирает огрызки и что
 * повтор после отмены проходит.
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { progress, type ProgressEvent } from '../src/core/progress.js';
import { describeMedia } from '../src/util/ffmpeg.js';
import { run } from '../src/util/exec.js';
import { requireTool } from '../src/util/tools.js';
import { downloadYt, resolveYt, type DownloadQuality } from '../src/util/ytdlp.js';

const URL = process.argv[2] ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const QUALITY: DownloadQuality = '1080p';
const toolsDir = path.resolve('.dubpipe', 'tools');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const bytes = (value: number | undefined): string =>
  value === undefined ? '—' : `${(value / 1024 ** 2).toFixed(1)} МБ`;

const dir = await mkdtemp(path.join(tmpdir(), 'dubpipe-yt-'));
console.log(`Папка проверки: ${dir}\n`);

try {
  // --- 1. Разбор ссылки без загрузки ---------------------------------------
  console.log('1. Разбор ссылки');
  const info = await resolveYt(URL, toolsDir, QUALITY);
  console.log(`   ${info.title} — ${info.uploader ?? '?'}`);
  console.log(`   ${info.durationSeconds ?? '?'} с, ${info.height ?? '?'}p, ${bytes(info.bytes ?? undefined)}`);
  check('есть идентификатор', info.id.length > 0, info.id);
  check('есть название', info.title.length > 0);
  check('есть длительность', (info.durationSeconds ?? 0) > 0);
  check('прямой эфир распознан как обычный ролик', !info.isLive);

  // --- 2. Отмена: огрызки должны исчезнуть ---------------------------------
  console.log('\n2. Отмена на середине');
  const controller = new AbortController();
  const samples: ProgressEvent[] = [];
  const off = progress.subscribe((event) => {
    if (event.kind === 'download') samples.push(event);
  });
  // Полсекунды: тридцать мегабайт качаются быстрее, чем успевает включиться
  // сведение дорожек, — иначе отмена придётся на него, и проверять будет нечего.
  const started = Date.now();
  setTimeout(() => controller.abort(), 500);
  let cancelled = false;
  try {
    await downloadYt(URL, dir, toolsDir, {
      quality: QUALITY,
      container: 'mp4',
      filenameTemplate: '%(title)s [%(id)s].%(ext)s',
      label: info.title,
      expectedBytes: info.bytes,
      videoId: info.id,
      signal: controller.signal,
    });
  } catch {
    cancelled = true;
  } finally {
    off();
  }
  const afterCancel = await readdir(dir);
  check('загрузка прервана', cancelled, `через ${Date.now() - started} мс`);
  check('после отмены в папке пусто', afterCancel.length === 0, afterCancel.join(', ') || 'пусто');
  check('прогресс приходил', samples.length > 0, `событий: ${samples.length}`);
  const withPercent = samples.filter((event) => typeof event.percent === 'number');
  const withBytes = samples.filter((event) => (event.receivedBytes ?? 0) > 0);
  check('в прогрессе есть проценты', withPercent.length > 0, `из ${samples.length}`);
  check('в прогрессе есть байты', withBytes.length > 0, `из ${samples.length}`);
  if (withPercent.length > 0) {
    const last = withPercent[withPercent.length - 1]!;
    console.log(`   последний: ${last.percent}%, ${bytes(last.receivedBytes)} из ${bytes(last.totalBytes)}`);
  }

  // --- 3. Загрузка целиком после отмены ------------------------------------
  console.log('\n3. Повтор после отмены');
  const startedFull = Date.now();
  const files = await downloadYt(URL, dir, toolsDir, {
    quality: QUALITY,
    container: 'mp4',
    filenameTemplate: '%(title)s [%(id)s].%(ext)s',
    label: info.title,
    expectedBytes: info.bytes,
    videoId: info.id,
  });
  const size = files[0] ? (await stat(files[0])).size : 0;
  check('файл получен', files.length === 1 && size > 0, path.basename(files[0] ?? '—'));
  check('имя содержит id', (files[0] ?? '').includes(info.id));
  console.log(`   ${bytes(size)} за ${((Date.now() - startedFull) / 1000).toFixed(1)} с`);
  const leftovers = (await readdir(dir)).filter((name) => /\.part$|\.f\d+\./.test(name));
  check('после успешной загрузки мусора нет', leftovers.length === 0, leftovers.join(', ') || 'пусто');

  // --- 4. Повторный запуск не качает второй раз ----------------------------
  console.log('\n4. Повтор не скачивает заново');
  const again = await downloadYt(URL, dir, toolsDir, {
    quality: QUALITY,
    container: 'mp4',
    filenameTemplate: '%(title)s [%(id)s].%(ext)s',
    label: info.title,
    expectedBytes: info.bytes,
    videoId: info.id,
  });
  const total = (await readdir(dir)).length;
  check('файл тот же', again[0] === files[0], path.basename(again[0] ?? '—'));
  check('второй копии не появилось', total === 1, `файлов: ${total}`);

  // --- 5. Данные и обложка внутри файла -------------------------------------
  console.log('\n5. Данные и обложка внутри файла');
  const embedded = await downloadYt(URL, dir, toolsDir, {
    quality: 'audio',
    container: 'mp4',
    filenameTemplate: '%(title)s [%(id)s].%(ext)s',
    label: info.title,
    videoId: info.id,
    embedMetadata: true,
    embedThumbnail: true,
  });
  const target = embedded[0]!;
  const ffprobe = await requireTool('ffprobe', toolsDir);
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', target], {
    timeoutMs: 120_000,
    captureStdout: true,
  });
  const probe = JSON.parse(stdout) as {
    format?: { tags?: Record<string, string> };
    streams?: Array<{ codec_type?: string; disposition?: { attached_pic?: number } }>;
  };
  const tags = probe.format?.tags ?? {};
  const cover = (probe.streams ?? []).some((stream) => stream.disposition?.attached_pic === 1);
  check('файл подписан', Boolean(tags['title']), tags['title'] ?? 'нет title');
  check('в тегах есть канал', Boolean(tags['artist']), tags['artist'] ?? 'нет artist');
  check('в тегах есть ссылка на источник', Boolean(tags['purl'] ?? tags['comment']), tags['purl'] ?? tags['comment'] ?? 'нет');
  check('обложка вложена', cover);

  // Главное: обложка — это видеопоток, и без проверки пометки `attached_pic`
  // звуковой файл считался бы видео, а S7 собрал бы mp4 с картинкой.
  const described = describeMedia(probe);
  check('звуковой файл с обложкой не считается видео', !described.hasVideo);
  check('длительность прочитана', described.durationSeconds > 0, `${described.durationSeconds.toFixed(1)} с`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nВСЁ ПРОШЛО' : `\nПРОВАЛЕНО ПРОВЕРОК: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
