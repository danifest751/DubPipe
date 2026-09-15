import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config/load.js';
import { ConfigError } from '../src/core/errors.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';

/**
 * Ключ, вставленный в поле имени переменной. Так делают, и раньше это давало
 * два эффекта разом: токен печатался на экране в панели готовности, а секрет
 * сохранялся под именем, равным самому токену.
 */

const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + 'x'.repeat(120) + '.abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

describe('§5.3: api_key_env — имя переменной, а не ключ', () => {
  it('отвергает токен в поле имени с понятным объяснением', () => {
    try {
      parseConfig({ kilo_gateway: { api_key_env: FAKE_TOKEN } }, 'test');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('kilo_gateway.api_key_env');
      expect((error as ConfigError).message).toContain('имя переменной');
      // Сообщение об ошибке само не должно повторять токен целиком.
      expect((error as ConfigError).message).not.toContain('x'.repeat(120));
    }
  });

  it('принимает обычное имя переменной', () => {
    expect(parseConfig({ kilo_gateway: { api_key_env: 'MY_KILO_KEY' } }, 'test').kilo_gateway.api_key_env).toBe('MY_KILO_KEY');
  });
});

describe('Интерфейс: лечение вставленного не туда ключа при запуске', () => {
  let server: UiServerHandle;
  let dir: string;
  let configPath: string;
  /*
   * Свой рабочий каталог, а не общий `.dubpipe` проекта.
   *
   * Секрет пишется рядом с кэшем, и на общем каталоге это была гонка: соседний
   * файл тестов на выходе удаляет `.dubpipe/secrets.json`, если его не было на
   * старте, — и удалял тот, что записан здесь. На CI это давало ENOENT ровно в
   * одном задании из четырёх, то есть выглядело случайностью.
   */
  let secretsPath = '';
  const previousEnv = process.env['KILO_API_KEY'];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'dubpipe-key-'));
    configPath = path.join(dir, 'config.yaml');
    const cacheDir = path.join(dir, 'cache');
    secretsPath = path.join(cacheDir, 'secrets.json');
    const lines = [
      '# настройки',
      'kilo_gateway:',
      `  api_key_env: ${FAKE_TOKEN}   # сюда вставили ключ`,
      'translate:',
      '  batch_size: 9',
      'cache:',
      `  dir: ${JSON.stringify(cacheDir)}`,
      '',
    ];
    writeFileSync(configPath, lines.join('\n'), 'utf8');
    server = await startUiServer({ port: 0, configPath });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    if (previousEnv === undefined) delete process.env['KILO_API_KEY'];
    else process.env['KILO_API_KEY'] = previousEnv;
  });

  const get = (route: string) => fetch(`http://127.0.0.1:${server.port}${route}?token=${server.token}`);

  it('сервер запускается, а не падает на невалидном файле', () => {
    expect(server.port).toBeGreaterThan(0);
  });

  it('в файле настроек снова имя переменной, комментарии целы', async () => {
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('api_key_env: KILO_API_KEY');
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).toContain('# настройки');
    expect(text).toContain('batch_size: 9');

    const data = ((await (await get('/api/config')).json()) as Record<string, any>);
    expect(data.parsed.kilo_gateway.api_key_env).toBe('KILO_API_KEY');
  });

  it('ключ сохранён под штатным именем и считается заданным', async () => {
    const saved = JSON.parse(readFileSync(secretsPath, 'utf8')) as Record<string, string>;
    expect(saved['KILO_API_KEY']).toBe(FAKE_TOKEN);
    expect(saved[FAKE_TOKEN]).toBeUndefined();

    const key = ((await (await get('/api/key')).json()) as Record<string, any>);
    expect(key.set).toBe(true);
    expect(key.env).toBe('KILO_API_KEY');
  });

  it('токен не появляется ни в готовности, ни в окружении', async () => {
    const readiness = await (await get('/api/readiness')).text();
    const environment = await (await get('/api/environment')).text();
    expect(readiness).not.toContain(FAKE_TOKEN);
    expect(environment).not.toContain(FAKE_TOKEN);
    expect(readiness).toContain('KILO_API_KEY');
  });
});
