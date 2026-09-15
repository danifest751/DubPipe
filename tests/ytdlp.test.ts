import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildYtArgs,
  classifyYtError,
  collectDownloadResults,
  estimateDownload,
  formatSelector,
  isYtDlpStale,
  parseProgressLine,
  parseYtJson,
  removePartialArtifacts,
  snapshotDir,
  type DownloadOptions,
  type ProgressState,
} from '../src/util/ytdlp.js';

/**
 * Разбор ссылок и загрузки — без сети и без yt-dlp.
 *
 * Строки прогресса здесь настоящие: сняты с встроенного yt-dlp 2026.08.19 при
 * загрузке роликаworst-качеством (дорожки видео и звука, 1.8 МБ). Именно на них
 * видно всё, что ломает наивный разбор: `NA` в половине полей, `total_bytes`
 * только на последней строке дорожки и счётчик, который начинается заново на
 * второй дорожке.
 */

const PROGRESS_FIXTURE = [
  'PROG|d=712|t=712|ts=NA|s=569.6000000000001|eta=NA|st=downloading',
  'PROG|d=57145|t=355433.0|ts=NA|s=44475.2315872272|eta=NA|st=downloading',
  'PROG|d=379047|t=532032.3703703703|ts=NA|s=131872.36616628885|eta=2.0930356336659033|st=downloading',
  'PROG|d=572191|t=NA|ts=572191|s=147059.84540726405|eta=NA|st=finished',
  'PROG|d=1024|t=1024|ts=NA|s=3303.2258066831682|eta=NA|st=downloading',
  'PROG|d=946161|t=1238455.3793103448|ts=NA|s=331095.1990388406|eta=1.6538253518205361|st=downloading',
  'PROG|d=1313287|t=NA|ts=1313287|s=355513.2815391965|eta=NA|st=finished',
];

const EXPECTED_TOTAL = 572191 + 1313287;

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dubpipe-ytdlp-'));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('§FR-1: разбор строк прогресса yt-dlp', () => {
  it('складывает байты обеих дорожек и не откатывается назад', () => {
    const state: ProgressState = { finishedBytes: 0, previousBytes: 0 };
    const received: number[] = [];
    for (const line of PROGRESS_FIXTURE) {
      const sample = parseProgressLine(line, state, EXPECTED_TOTAL);
      expect(sample).not.toBeNull();
      received.push(sample!.downloadedBytes);
    }

    // Монотонность: полоса не должна дёргаться назад на стыке дорожек.
    for (let index = 1; index < received.length; index++) {
      expect(received[index]!).toBeGreaterThanOrEqual(received[index - 1]!);
    }
    expect(received[received.length - 1]).toBe(EXPECTED_TOTAL);
  });

  it('считает процент по всему файлу, а не по дорожке', () => {
    const state: ProgressState = { finishedBytes: 0, previousBytes: 0 };
    let last = parseProgressLine(PROGRESS_FIXTURE[0]!, state, EXPECTED_TOTAL)!;
    for (const line of PROGRESS_FIXTURE.slice(1)) last = parseProgressLine(line, state, EXPECTED_TOTAL)!;
    const percent = (last.downloadedBytes / last.totalBytes!) * 100;
    // Если бы процент считался по дорожке, вторая дорожка начиналась бы с нуля.
    expect(percent).toBe(100);
  });

  it('без ожидаемого размера не выдумывает проценты', () => {
    const state: ProgressState = { finishedBytes: 0, previousBytes: 0 };
    const sample = parseProgressLine(PROGRESS_FIXTURE[1]!, state, null);
    expect(sample!.totalBytes).toBeNull();
    expect(sample!.downloadedBytes).toBeGreaterThan(0);
  });

  it('берёт ETA из строки, когда размер неизвестен', () => {
    const state: ProgressState = { finishedBytes: 0, previousBytes: 0 };
    const sample = parseProgressLine(PROGRESS_FIXTURE[2]!, state, null);
    expect(sample!.etaSeconds).toBeCloseTo(2.09, 1);
  });

  it('считает ETA по всему файлу, когда размер известен', () => {
    const state: ProgressState = { finishedBytes: 0, previousBytes: 0 };
    const sample = parseProgressLine(PROGRESS_FIXTURE[1]!, state, EXPECTED_TOTAL);
    // (1885478 - 57145) / 44475 ≈ 41 с, а не 0 из строки (там NA).
    expect(sample!.etaSeconds).toBeGreaterThan(30);
  });

  it('видит конец дорожки по status', () => {
    const state: ProgressState = { finishedBytes: 0, previousBytes: 0 };
    expect(parseProgressLine(PROGRESS_FIXTURE[3]!, state, EXPECTED_TOTAL)!.finished).toBe(true);
    expect(parseProgressLine(PROGRESS_FIXTURE[2]!, state, EXPECTED_TOTAL)!.finished).toBe(false);
  });

  it('игнорирует чужие строки', () => {
    const state: ProgressState = { finishedBytes: 0, previousBytes: 0 };
    expect(parseProgressLine('[download] Destination: video.mp4', state, null)).toBeNull();
    expect(parseProgressLine('PROG|st=downloading', state, null)).toBeNull();
  });
});

describe('§FR-1: выбор дорожки', () => {
  it('ограничивает высоту для 1080p и 720p', () => {
    expect(formatSelector('1080p')).toBe('bv*[height<=1080]+ba/b[height<=1080]/b');
    expect(formatSelector('720p')).toBe('bv*[height<=720]+ba/b[height<=720]/b');
  });

  it('не ограничивает лучшее качество', () => {
    expect(formatSelector('best')).toBe('bv*+ba/b');
  });

  it('для звука предпочитает m4a — его не нужно перекодировать', () => {
    expect(formatSelector('audio')).toBe('ba[ext=m4a]/ba/b');
  });

  it('оценивает размер как сумму дорожек видео и звука', () => {
    const formats = [
      { vcodec: 'avc1', acodec: 'none', height: 1080, filesize: 40_000_000 },
      { vcodec: 'avc1', acodec: 'none', height: 720, filesize: 20_000_000 },
      { vcodec: 'none', acodec: 'mp4a', filesize_approx: 2_000_000 },
    ];
    expect(estimateDownload(formats, '1080p')).toEqual({ height: 1080, bytes: 42_000_000 });
    expect(estimateDownload(formats, '720p')).toEqual({ height: 720, bytes: 22_000_000 });
    expect(estimateDownload(formats, 'audio')).toEqual({ height: null, bytes: 2_000_000 });
  });

  it('честно молчит о размере, когда его нет', () => {
    const formats = [{ vcodec: 'vp9', acodec: 'none', height: 1080 }];
    expect(estimateDownload(formats, '1080p').bytes).toBeNull();
  });

  it('берёт прогрессивную дорожку, если раздельных нет', () => {
    const formats = [{ vcodec: 'avc1', acodec: 'mp4a', height: 360, filesize: 5_000_000 }];
    expect(estimateDownload(formats, '1080p')).toEqual({ height: 360, bytes: 5_000_000 });
  });
});

describe('FR-1: метаданные ссылки до загрузки', () => {
  it('разбирает один ролик', () => {
    const info = parseYtJson(
      {
        id: 'dQw4w9WgXcQ',
        title: 'Ролик',
        channel: 'Канал',
        webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        duration: 213,
        is_live: false,
        thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg',
        formats: [
          { vcodec: 'avc1', acodec: 'none', height: 1080, filesize: 40_000_000 },
          { vcodec: 'none', acodec: 'mp4a', filesize_approx: 2_000_000 },
        ],
      },
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(info.isPlaylist).toBe(false);
    expect(info.title).toBe('Ролик');
    expect(info.uploader).toBe('Канал');
    expect(info.durationSeconds).toBe(213);
    expect(info.height).toBe(1080);
    expect(info.bytes).toBe(42_000_000);
  });

  it('разбирает плейлист и суммирует длительности', () => {
    const info = parseYtJson(
      {
        _type: 'playlist',
        id: 'PL1',
        title: 'Курс',
        entries: [
          { id: 'a', url: 'https://youtu.be/a', title: 'Первое', duration: 600 },
          { id: 'b', url: 'https://youtu.be/b', title: 'Второе', duration: 900 },
        ],
      },
      'https://www.youtube.com/playlist?list=PL1',
    );
    expect(info.isPlaylist).toBe(true);
    expect(info.durationSeconds).toBe(1500);
    expect(info.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(info.bytes).toBeNull();
  });

  it('не падает на пустых метаданных', () => {
    const info = parseYtJson({}, 'https://youtu.be/x');
    expect(info.title).toBe('(без названия)');
    expect(info.durationSeconds).toBeNull();
    expect(info.bytes).toBeNull();
  });
});

describe('FR-1: набор аргументов yt-dlp', () => {
  const options: DownloadOptions = {
    quality: '1080p',
    container: 'mp4',
    filenameTemplate: '%(title)s [%(id)s].%(ext)s',
  };
  const template = path.join('/tmp', '%(title)s [%(id)s].%(ext)s');

  it('закрывает список аргументов перед ссылкой', () => {
    const args = buildYtArgs('/ffmpeg', 'https://youtu.be/x', options, template);
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('https://youtu.be/x');
  });

  it('по умолчанию берёт одно видео и mp4', () => {
    const args = buildYtArgs('/ffmpeg', 'https://youtu.be/x', options, template);
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--merge-output-format');
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4');
    expect(args[args.indexOf('--progress-delta') + 1]).toBe('1');
  });

  it('для звука не просит сведение в mp4', () => {
    const args = buildYtArgs('/ffmpeg', 'https://youtu.be/x', { ...options, quality: 'audio' }, template);
    expect(args).not.toContain('--merge-output-format');
    expect(args[args.indexOf('-f') + 1]).toBe('ba[ext=m4a]/ba/b');
  });

  it('элементы плейлиста отменяют одиночный режим', () => {
    const args = buildYtArgs('/ffmpeg', 'https://youtu.be/x', { ...options, playlistItems: '1-3' }, template);
    expect(args).not.toContain('--no-playlist');
    expect(args[args.indexOf('-I') + 1]).toBe('1-3');
  });

  it('передаёт куки, субтитры, превью и число потоков', () => {
    const args = buildYtArgs(
      '/ffmpeg',
      'https://youtu.be/x',
      {
        ...options,
        cookiesFromBrowser: 'chrome',
        cookiesFile: 'cookies.txt',
        writeThumbnail: true,
        writeSubtitles: true,
        subtitleLanguages: ['en', 'ru'],
        concurrentFragments: 4,
      },
      template,
    );
    expect(args).toContain('--cookies-from-browser');
    expect(args).toContain('--cookies');
    expect(args).toContain('--write-thumbnail');
    expect(args).toContain('--write-subs');
    expect(args[args.indexOf('--sub-langs') + 1]).toBe('en,ru');
    expect(args[args.indexOf('--concurrent-fragments') + 1]).toBe('4');
  });
});

describe('FR-1: что осталось в папке', () => {
  it('видит итоговый файл среди появшихся', async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, 'старое.mp4'), 'old');
    const before = await snapshotDir(dir);

    await writeFile(path.join(dir, 'видео [abc].mp4'), 'new');
    await writeFile(path.join(dir, 'видео [abc].info.json'), '{}');
    await writeFile(path.join(dir, 'видео [abc].jpg'), 'thumb');

    const files = await collectDownloadResults(dir, before, 'abc');
    // Превью и метаданные итогом не считаются.
    expect(files.map((file) => path.basename(file))).toEqual(['видео [abc].mp4']);
  });

  it('находит уже скачанный ролик, когда ничего не появилось', async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, 'Ролик [dQw4w9WgXcQ].mp4'), 'old');
    const before = await snapshotDir(dir);
    const files = await collectDownloadResults(dir, before, 'dQw4w9WgXcQ');
    expect(files.map((file) => path.basename(file))).toEqual(['Ролик [dQw4w9WgXcQ].mp4']);
  });

  it('не отдаёт огрызки вместо итога', async () => {
    const dir = await makeDir();
    const before = await snapshotDir(dir);
    await writeFile(path.join(dir, 'видео.f396.mp4.part'), 'part');
    await writeFile(path.join(dir, 'видео.f251.webm'), 'track');
    expect(await collectDownloadResults(dir, before, 'abc')).toEqual([]);
  });

  it('убирает огрызки после отмены и не трогает чужое', async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, 'чужой фильм.mp4'), 'other');
    const before = await snapshotDir(dir);

    await writeFile(path.join(dir, 'видео.f396.mp4.part'), 'part');
    await writeFile(path.join(dir, 'видео.f251.webm'), 'track');
    await writeFile(path.join(dir, 'видео [abc].mp4'), 'done');

    await removePartialArtifacts(dir, before);

    const left = [...(await snapshotDir(dir)).keys()].sort();
    expect(left).toEqual(['видео [abc].mp4', 'чужой фильм.mp4']);
  });
});

describe('FR-1: объяснение ошибок yt-dlp', () => {
  const cases: Array<[string, string]> = [
    ['ERROR: Sign in to confirm you are not a bot', 'подтвердите'],
    ['ERROR: Private video. Sign in if you have been granted access', 'приватное'],
    ['ERROR: Join this channel to get access to members-only content', 'участников'],
    ['ERROR: Video unavailable', 'недоступно'],
    ['ERROR: This video is not available in your country', 'регионе'],
    ['ERROR: Requested format is not available', 'качество'],
    ['ERROR: Unable to download webpage: urlopen error', 'сети'],
    ['ERROR: Unable to rename file: [WinError 32]', 'занят'],
  ];

  it('на каждую частую причину даёт объяснение и подсказку', () => {
    for (const [stderr, expected] of cases) {
      const error = classifyYtError(stderr);
      expect(error.message.toLowerCase()).toContain(expected);
      expect(error.hints.length).toBeGreaterThan(0);
    }
  });

  it('просит куки там, где без них не обойтись', () => {
    expect(classifyYtError('Sign in to confirm you are not a bot').hints.join(' ')).toContain('--cookies-from-browser');
  });

  it('на незнакомую ошибку предлагает обновить yt-dlp', () => {
    const error = classifyYtError('ERROR: что-то новое и непонятное');
    expect(error.hints.join(' ')).toContain('dub tools update yt-dlp');
    expect(error.message).toContain('что-то новое и непонятное');
  });
});

describe('FR-1: возраст встроенного yt-dlp', () => {
  const now = new Date('2026-09-16T00:00:00Z');

  it('видит свежую версию', () => {
    expect(isYtDlpStale('2026.08.19', now)).toBe(false);
  });

  it('видит устаревшую', () => {
    // YouTube ломает разбор несколько раз в год: полтора месяца — уже повод обновиться.
    expect(isYtDlpStale('2026.06.01', now)).toBe(true);
  });

  it('не пугает на непонятной версии', () => {
    expect(isYtDlpStale('nightly', now)).toBe(false);
    expect(isYtDlpStale('', now)).toBe(false);
  });
});
