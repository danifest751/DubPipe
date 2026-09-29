import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config/load.js';
import { describeCompute } from '../src/core/compute.js';
import { parseFasterWhisperWords } from '../src/providers/asr/faster-whisper.js';
import { chooseAccel, classifyAdapters } from '../src/providers/asr/accel.js';
import {
  fetchWorkerFile,
  onServer,
  resetWorkerHealth,
  runWorkerJob,
  serverUnavailable,
  workerHealth,
  type WorkerHealth,
} from '../src/providers/remote/server.js';

/**
 * Сервер с видеокартой: как он подставляется в настройки и как с ним говорит
 * конвейер. Сам сервис (python/dubpipe_worker.py) здесь заменён поддельным
 * HTTP-сервером с тем же протоколом — проверяется клиент, а не Python.
 */

const HEALTH: WorkerHealth = {
  ok: true,
  protocol: 1,
  capabilities: { asr: true, diarization: true, separation: true, tts: false },
  gpu: { name: 'NVIDIA CMP 50HX', memory_used_mb: 4096, memory_total_mb: 20480, utilization: 0, temperature: 55 },
  running: null,
  waiting: 0,
};

describe('Сервер в настройках', () => {
  it('без адреса всё считается здесь', () => {
    const config = parseConfig({}, 'test');
    expect(config.server.host).toBeNull();
    expect(onServer(config, 'asr')).toBe(false);
    expect(config.translate.ollama_endpoint).toBe('http://127.0.0.1:11434');
  });

  it('пустое поле адреса — это «сервера нет», а не адрес из пустой строки', () => {
    expect(parseConfig({ server: { host: '  ' } }, 'test').server.host).toBeNull();
    expect(parseConfig({ server: { host: ' 192.168.0.70 ' } }, 'test').server.host).toBe('192.168.0.70');
  });

  it('не принимает адрес со схемой или портом в строке', () => {
    expect(() => parseConfig({ server: { host: 'http://192.168.0.70:8770' } }, 'test')).toThrow(/server\.host/);
  });

  it('отдаёт локальный перевод Ollama сервера вместе с его моделью', () => {
    const config = parseConfig({ profile: 'offline', server: { host: '192.168.0.70' } }, 'test');
    expect(config.translate.ollama_endpoint).toBe('http://192.168.0.70:11434');
    expect(config.translate.engine).toBe('ollama');
    // Имя модели рабочего компьютера на сервере ничего не значит.
    expect(config.translate.model).toBe('gemma4:26b-a4b-it-qat');
    expect(config.translate.fallback_model).toBe('gemma4:26b-a4b-it-qat');
  });

  it('облачный перевод hybrid не трогает: сервер становится запасным путём', () => {
    const config = parseConfig(
      { profile: 'hybrid', translate: { model: 'anthropic/claude-sonnet-4.5' }, server: { host: 'me4me' } },
      'test',
    );
    expect(config.translate.engine).toBe('kilo-gateway');
    expect(config.translate.model).toBe('anthropic/claude-sonnet-4.5');
    expect(config.translate.fallback_model).toBe('gemma4:26b-a4b-it-qat');
    expect(config.translate.ollama_endpoint).toBe('http://me4me:11434');
  });

  it('выключенный сервер не стирает адрес, но и не используется', () => {
    const config = parseConfig({ profile: 'offline', server: { host: 'me4me', enabled: false } }, 'test');
    expect(config.server.host).toBe('me4me');
    expect(onServer(config, 'asr')).toBe(false);
    expect(config.translate.ollama_endpoint).toBe('http://127.0.0.1:11434');
  });

  it('выбранную человеком модель не подменяет — только нетронутую по умолчанию', () => {
    const chosen = parseConfig({ profile: 'offline', translate: { model: 'gpt-oss:20b' }, server: { host: 'me4me' } }, 'test');
    expect(chosen.translate.model).toBe('gpt-oss:20b');
    const forced = parseConfig(
      { profile: 'offline', translate: { model: 'gpt-oss:20b' }, server: { host: 'me4me', translate_model: 'qwen3.6:27b' } },
      'test',
    );
    expect(forced.translate.model).toBe('qwen3.6:27b');
  });

  it('стадия, не отданная серверу, остаётся здесь', () => {
    const config = parseConfig(
      { profile: 'offline', translate: { ollama_endpoint: 'http://127.0.0.1:11434' }, server: { host: 'me4me', stages: { translate: false, tts: false } } },
      'test',
    );
    expect(onServer(config, 'asr')).toBe(true);
    expect(onServer(config, 'tts')).toBe(false);
    expect(config.translate.ollama_endpoint).toBe('http://127.0.0.1:11434');
  });
});

describe('Слова faster-whisper', () => {
  it('разбирает по тем же правилам, что и whisper.cpp', () => {
    const words = parseFasterWhisperWords({
      words: [
        { word: ' (eerie', start: 0, end: 0.5 },
        { word: ' music)', start: 0.5, end: 1 },
        { word: ' Hello', start: 1.2, end: 1.5 },
        { word: ' ♪', start: 1.6, end: 1.8 },
        // Последнее слово фразы, растянутое через музыкальную паузу.
        { word: ' world.', start: 2, end: 30 },
      ],
    });
    expect(words.map((word) => word.word)).toEqual(['Hello', 'world.']);
    expect(words[1]!.end).toBeCloseTo(4.5);
  });
});

describe('Карта вычислений с сервером', () => {
  const hardware = classifyAdapters(['AMD Radeon 780M Graphics']);
  const python = { available: true, executable: 'python', missing: [], providers: ['CPUExecutionProvider'] };
  const config = parseConfig(
    { tts: { engine: 'silero', default_voice: 'ru_zhadyra' }, separation: { enabled: true }, server: { host: 'me4me' } },
    'test',
  );
  const map = (health: WorkerHealth | null) =>
    describeCompute(config, hardware, chooseAccel(config.asr.backend, hardware), python, health);

  it('показывает стадии на видеокарте сервера', () => {
    const result = map(HEALTH);
    const where = Object.fromEntries(result.stages.map((stage) => [stage.stage, stage.where]));
    expect(where['Распознавание речи']).toBe('сервер me4me (NVIDIA CMP 50HX)');
    expect(where['Разбор по голосам']).toContain('сервер');
    expect(where['Отделение голоса']).toContain('сервер');
    expect(result.server).toEqual({ host: 'me4me', online: true, gpu: 'NVIDIA CMP 50HX' });
  });

  it('стадию, для которой на сервере ничего нет, считает здесь и говорит почему', () => {
    const result = map(HEALTH);
    expect(result.stages.find((stage) => stage.stage === 'Синтез речи')!.where).toBe('процессор');
    expect(result.hints.some((hint) => hint.startsWith('Синтез речи'))).toBe(true);
  });

  it('молчащий сервер не выдаёт за работающий', () => {
    const result = map(null);
    expect(result.server?.online).toBe(false);
    expect(result.stages.every((stage) => !stage.where.startsWith('сервер'))).toBe(true);
  });
});

describe('Протокол сервиса', () => {
  let server: http.Server;
  let port = 0;
  let received = 0;
  const dir = mkdtempSync(path.join(tmpdir(), 'dubpipe-worker-'));
  const input = path.join(dir, 'input.wav');
  writeFileSync(input, Buffer.alloc(100_000, 1));

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') {
        response.end(JSON.stringify(HEALTH));
        return;
      }
      if (url.pathname === '/v1/files/abc/out.wav') {
        response.end('RIFF-result');
        return;
      }
      if (request.method === 'POST') {
        let size = 0;
        request.on('data', (chunk: Buffer) => (size += chunk.length));
        request.on('end', () => {
          received = size;
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          if (url.pathname === '/v1/asr') {
            response.write(`${JSON.stringify({ event: 'log', text: 'видеокарта не взяла модель (CUDA out of memory); считаю на процессоре' })}
`);
            response.end(`${JSON.stringify({ event: 'done', job: 'cpu', seconds: 600, result: {}, files: {} })}
`);
            return;
          }
          if (url.pathname === '/v1/separate') {
            response.end(`${JSON.stringify({ event: 'error', error: 'CUDA out of memory' })}\n`);
            return;
          }
          response.write(`${JSON.stringify({ event: 'accepted', job: 'abc' })}\n`);
          response.write(`${JSON.stringify({ event: 'progress', percent: 40 })}\n`);
          response.write(`${JSON.stringify({ event: 'alive' })}\n`);
          response.end(
            `${JSON.stringify({ event: 'done', job: 'abc', seconds: 2, result: { turns: [] }, files: { 'out.wav': '/v1/files/abc/out.wav' } })}\n`,
          );
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  const config = () => parseConfig({ server: { host: '127.0.0.1', worker_port: port, free_gpu_memory: false } }, 'test');

  it('узнаёт, что сервис жив и что он умеет', async () => {
    resetWorkerHealth();
    expect((await workerHealth(config(), 0))?.gpu?.name).toBe('NVIDIA CMP 50HX');
    expect(await serverUnavailable(config(), 'asr')).toBeNull();
    expect(await serverUnavailable(config(), 'tts')).toMatch(/не установлено/);
  });

  it('отдаёт файл целиком и получает ход работы и результат', async () => {
    const percents: number[] = [];
    const job = await runWorkerJob(config(), 'diarize', { model: 'x' }, input, { onProgress: (p) => percents.push(p) });
    expect(received).toBe(100_000);
    expect(percents).toEqual([40]);
    expect(job.result).toEqual({ turns: [] });
    const target = path.join(dir, 'out.wav');
    await fetchWorkerFile(config(), job.files['out.wav']!, target);
    expect(readFileSync(target, 'utf8')).toBe('RIFF-result');
  });

  it('замечает, что сервер посчитал на процессоре', async () => {
    expect((await runWorkerJob(config(), 'asr', {}, input)).onCpu).toBe(true);
    expect((await runWorkerJob(config(), 'diarize', {}, input)).onCpu).toBe(false);
  });

  it('ошибку сервиса доносит словами', async () => {
    await expect(runWorkerJob(config(), 'separate', {}, input)).rejects.toThrow('CUDA out of memory');
  });

  it('молчащий адрес — причина, а не исключение', async () => {
    resetWorkerHealth();
    const dead = parseConfig({ server: { host: '127.0.0.1', worker_port: 1 } }, 'test');
    expect(await serverUnavailable(dead, 'asr')).toMatch(/не отвечает/);
  });
});
