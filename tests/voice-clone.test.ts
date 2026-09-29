import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config/load.js';
import { EMPTY_OVERRIDES, effectiveVoice, planReview } from '../src/core/overrides.js';
import { ttsKey } from '../src/stages/s5-tts.js';
import { makeSegment, type Segment } from '../src/core/types.js';
import { EDGE_FRAME_SECONDS, pickReference, referenceCandidates, referenceEdges } from '../src/core/voice-refs.js';
import { computeFingerprints, stageConfigSlice } from '../src/core/workspace.js';
import { CloneError, cloneSpeech, ensureCloneRef, resetWorkerHealth } from '../src/providers/remote/server.js';
import { fitsLength } from '../src/providers/tts/clone.js';

/**
 * Голоса актёров: образцы голосов, перезапуск при их смене и разговор с сервером.
 *
 * Правила подбора образца выведены из пробы на восьмом эпизоде: реплика с долгой
 * паузой внутри («Oh, my God.» на 3.2 с) давала модели текст, не совпадающий со
 * звуком, и в начале озвученных фраз проскакивали лишние звуки.
 */

const line = (id: number, speaker: string, start: number, end: number, text: string, extra: Partial<Segment> = {}): Segment =>
  makeSegment({ id, start, end, speaker, text_en: text, text_ru: 'реплика', ...extra });

const english = { charsPerSecond: 17 };

describe('образец голоса', () => {
  const segments = [
    // Плотная, 5 с, никто не мешает — лучший.
    line(0, 'speaker_0', 0, 5, 'Best case, they melt her down to her last circuit and panels.'),
    // Три слова на три секунды: внутри пауза.
    line(1, 'speaker_0', 10, 13.2, 'Oh, my God.'),
    // Хорошая по длине, но в ней говорит и второй голос.
    line(2, 'speaker_0', 20, 25, 'I thought we had agreed on this before we even left the base.'),
    // Спорная по тону — могла достаться не тому.
    line(3, 'speaker_0', 30, 34.5, 'You never listen to anything I say, do you, not even once.', { flags: ['speaker_doubt'] }),
    line(4, 'speaker_1', 40, 45, 'Translators, cultural advisors, mediators and everyone else.'),
  ];
  const turns = [
    { start: 0, end: 5, speaker: 'A' },
    { start: 10, end: 13.2, speaker: 'A' },
    { start: 20, end: 25, speaker: 'A' },
    { start: 22, end: 23, speaker: 'B' },
    { start: 30, end: 34.5, speaker: 'A' },
  ];

  it('берёт плотную реплику около пяти секунд, в которой никто не мешает', () => {
    const candidates = referenceCandidates(segments, turns, 'speaker_0', english);
    expect(candidates[0]!.id).toBe(0);
    expect(candidates.map((candidate) => candidate.id)).not.toContain(2);
    expect(candidates.map((candidate) => candidate.id)).not.toContain(3);
    // Реплика с паузой внутри остаётся в списке, но как запасная.
    expect(candidates.find((candidate) => candidate.id === 1)?.good).toBe(false);
  });

  it('не берёт чужие реплики', () => {
    expect(referenceCandidates(segments, turns, 'speaker_1', english).map((candidate) => candidate.id)).toEqual([4]);
  });

  it('выбор человека сильнее правил, «off» выключает клонирование', () => {
    expect(pickReference(segments, turns, 'speaker_0', english, 1)!.id).toBe(1);
    expect(pickReference(segments, turns, 'speaker_0', english, 'off')).toBeNull();
    // Чужая реплика выбором для этого персонажа не считается.
    expect(pickReference(segments, turns, 'speaker_0', english, 4)!.id).toBe(0);
    expect(pickReference(segments, turns, 'speaker_9', english)).toBeNull();
  });

  it('плотность меряется по языку оригинала', () => {
    const korean = [line(0, 'speaker_0', 0, 5, '그건 정말 어리석은 짓이었어 우리 얘기 좀 해')];
    expect(referenceCandidates(korean, [], 'speaker_0', { charsPerSecond: 9 })[0]!.good).toBe(true);
    expect(referenceCandidates(korean, [], 'speaker_0', english)[0]!.good).toBe(false);
  });
});

/**
 * Громкость кадрами по 20 мс: `[секунды, дБ]` — до следующей точки держится
 * этот уровень. Так записываются профили, снятые с настоящей дорожки.
 */
function levels(from: number, to: number, points: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let t = from; t < to - 1e-9; t += EDGE_FRAME_SECONDS) {
    let level = points[0]![1];
    for (const [at, db] of points) if (at <= t + 1e-9) level = db;
    out.push(level);
  }
  return out;
}

describe('края образца', () => {
  it('режет по паузе, а не по отметке распознавания, которая обрывает слово', () => {
    // «conversation» по распознаванию кончается на 228.06, а звучит до 228.56;
    // пауза перед следующей репликой — с 228.6.
    const profile = levels(221.6, 229.3, [[221.6, -60], [222.84, -24], [228.06, -50], [228.18, -26], [228.6, -60]]);
    const edges = referenceEdges(profile, 221.6, { start: 222.84, end: 228.06 }, { previousEnd: 221.0, nextStart: 228.9 });
    expect(edges).not.toBeNull();
    expect(edges!.end).toBeGreaterThan(228.6);
    expect(edges!.end).toBeLessThan(228.8);
    expect(edges!.start).toBeLessThan(222.84);
  });

  it('не берёт реплику, за которой без паузы идёт чужая', () => {
    // Так было на ролике FRANCE 24: «…the conversation. Take a listen.» встык.
    const profile = levels(221.6, 229.3, [[221.6, -60], [222.84, -24], [228.06, -50], [228.18, -26]]);
    expect(referenceEdges(profile, 221.6, { start: 222.84, end: 228.06 }, { previousEnd: 221.0, nextStart: 228.76 })).toBeNull();
  });

  it('короткий провал внутри слова паузой не считает', () => {
    // 0.1 с тишины на «conver·sation» — это не конец фразы.
    const profile = levels(0, 8, [[0, -60], [1, -20], [5.0, -50], [5.1, -20], [6.0, -60]]);
    const edges = referenceEdges(profile, 0, { start: 1, end: 5 }, { previousEnd: null, nextStart: 7 });
    expect(edges!.end).toBeGreaterThan(6);
  });
});

describe('смена образца в панели', () => {
  const config = parseConfig({ tts: { engine: 'piper', clone: { enabled: true } }, server: { host: 'me4me' } }, 'test');
  // Клип подписан так же, как его подписывает синтез: подпись сходится — синтез не нужен.
  const voiced = (id: number, speaker: string): Segment => ({
    ...line(id, speaker, id * 10, id * 10 + 3, 'text'),
    tts_key: ttsKey(effectiveVoice(config, EMPTY_OVERRIDES, speaker), 'реплика', 'piper'),
    tts_file: `${id}.wav`,
  });
  const segments = [voiced(0, 'speaker_0'), voiced(1, 'speaker_1'), voiced(2, 'speaker_0')];

  it('переозвучивает реплики персонажа с подгонки, а не с синтеза', () => {
    const plan = planReview(config, segments, segments, EMPTY_OVERRIDES, { ...EMPTY_OVERRIDES, refs: { speaker_0: 'off' } }, {}, 'piper');
    expect(plan.fromStage).toBe('s6');
    expect(plan.affected).toEqual([0, 2]);
  });

  it('при выключенных голосах актёров смена образца ничего не запускает', () => {
    const off = parseConfig({ tts: { engine: 'piper' } }, 'test');
    const plan = planReview(off, segments, segments, EMPTY_OVERRIDES, { ...EMPTY_OVERRIDES, refs: { speaker_0: 3 } }, {}, 'piper');
    expect(plan.fromStage).toBeNull();
  });
});

describe('отпечатки стадий', () => {
  it('включение голосов актёров не пересинтезирует базовый движок, но переделывает подгонку', () => {
    const plain = parseConfig({ server: { host: 'me4me' } }, 'test');
    const clone = parseConfig({ server: { host: 'me4me' }, tts: { clone: { enabled: true } } }, 'test');
    expect(stageConfigSlice('s5', plain)).toEqual(stageConfigSlice('s5', clone));
    const before = computeFingerprints(plain, 'input');
    const after = computeFingerprints(clone, 'input');
    expect(after.s5).toBe(before.s5);
    expect(after.s6).not.toBe(before.s6);
  });
});

describe('разговор с сервером', () => {
  let server: http.Server;
  let port = 0;
  const stored = new Set<string>();
  let puts = 0;
  const dir = mkdtempSync(path.join(tmpdir(), 'dubpipe-clone-'));
  const ref = path.join(dir, 'ref.wav');
  writeFileSync(ref, Buffer.from('RIFF-образец'));
  const key = createHash('sha256').update(Buffer.from('RIFF-образец')).digest('hex');

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = /^\/v1\/clone\/ref\/([0-9a-f]{64})$/.exec(url.pathname);
      if (match && request.method === 'GET') {
        response.writeHead(stored.has(match[1]!) ? 200 : 404).end('{}');
        return;
      }
      if (match && request.method === 'PUT') {
        puts++;
        request.resume();
        request.on('end', () => {
          stored.add(match[1]!);
          response.end('{"ok": true}');
        });
        return;
      }
      if (url.pathname === '/v1/clone') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ref: string; text: string };
          if (!stored.has(body.ref)) {
            response.writeHead(422).end(JSON.stringify({ error: 'образца нет' }));
            return;
          }
          const headers: Record<string, string> = { 'Content-Type': 'audio/wav' };
          if ((body as { check?: boolean }).check) headers['X-Heard'] = encodeURIComponent(`слышно: ${body.text}`);
          response.writeHead(200, headers).end(`RIFF:${body.text}`);
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    resetWorkerHealth();
  });

  afterAll(() => {
    server.close();
  });

  const config = () => parseConfig({ server: { host: '127.0.0.1', worker_port: port } }, 'test');

  it('кладёт образец один раз и узнаёт его по содержимому', async () => {
    expect(await ensureCloneRef(config(), ref)).toBe(key);
    expect(await ensureCloneRef(config(), ref)).toBe(key);
    expect(puts).toBe(1);
  });

  it('получает реплику голосом актёра; кириллица доходит в UTF-8', async () => {
    const { audio, heard } = await cloneSpeech(config(), { ref: key, ref_text: 'x', ref_lang: 'en', text: 'Мне всё равно, Джек.', duration: 1.6, steps: 32 });
    expect(audio.toString('utf8')).toBe('RIFF:Мне всё равно, Джек.');
    expect(heard).toBeNull();
  });

  it('с проверкой сервер возвращает услышанное — русский текст доходит целым', async () => {
    const { heard } = await cloneSpeech(config(), { ref: key, ref_text: 'x', ref_lang: 'en', text: 'Мне всё равно, Джек.', duration: 1.6, steps: 32, check: true });
    expect(heard).toBe('слышно: Мне всё равно, Джек.');
  });

  it('отказ сервера — ошибка с причиной, а не молчание', async () => {
    await expect(
      cloneSpeech(config(), { ref: 'f'.repeat(64), ref_text: 'x', ref_lang: 'en', text: 'а', duration: 1, steps: 32 }),
    ).rejects.toThrow(CloneError);
  });
});

describe('длина клипа голоса актёра', () => {
  it('клип вдвое длиннее заказа не берётся — он наедет на соседнюю реплику', () => {
    expect(fitsLength(29.46, 14.7)).toBe(false);
    expect(fitsLength(14.75, 14.7)).toBe(true);
    // На короткой реплике допуск — не меньше трёх десятых секунды.
    expect(fitsLength(1.8, 1.6)).toBe(true);
    expect(fitsLength(2.1, 1.6)).toBe(false);
    // Короче заказа — просто пауза.
    expect(fitsLength(1.0, 2.0)).toBe(true);
  });
});
