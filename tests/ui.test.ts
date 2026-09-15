import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';

/**
 * Проверки локального API интерфейса (ТЗ §16.5, §16.6).
 * Сеть, ffmpeg и ключи не нужны: сервер поднимается на свободном порту петлевого
 * интерфейса и опрашивается напрямую.
 */

let server: UiServerHandle;
const base = () => `http://127.0.0.1:${server.port}`;

const get = (route: string, token = server.token) =>
  fetch(`${base()}${route}${route.includes('?') ? '&' : '?'}token=${token}`);

beforeAll(async () => {
  server = await startUiServer({ port: 0 });
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/**
 * Тело ответа API. `json()` отдаёт `unknown`, а тесты знают форму каждого
 * ответа и проверяют поля напрямую — описывать её типом здесь незачем.
 */
type ResponseBody = Record<string, any>;

const asBody = async (response: Response): Promise<ResponseBody> => (await response.json()) as ResponseBody;

describe('§16.5: сервер слушает только петлевой интерфейс', () => {
  it('выдаёт адрес на 127.0.0.1 с токеном в ссылке', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]{48}$/);
  });

  it('порт выбирается свободный', () => {
    expect(server.port).toBeGreaterThan(0);
  });
});

describe('§16.5: доступ по одноразовому токену', () => {
  it('отклоняет запрос без токена', async () => {
    const response = await fetch(`${base()}/api/state`);
    expect(response.status).toBe(401);
  });

  it('отклоняет запрос с чужим токеном', async () => {
    const response = await get('/api/state', 'deadbeef');
    expect(response.status).toBe(401);
  });

  it('пропускает запрос с верным токеном', async () => {
    const response = await get('/api/state');
    expect(response.status).toBe(200);
  });

  it('принимает токен в заголовке', async () => {
    const response = await fetch(`${base()}/api/state`, { headers: { 'X-DubPipe-Token': server.token } });
    expect(response.status).toBe(200);
  });

  it('главная страница открывается без токена — он передаётся ей в ссылке', async () => {
    const response = await fetch(`${base()}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('DubPipe');
  });

  // Регрессия: токен закрывал и статику тоже. Браузер запрашивает style.css
  // и app.js без токена, получал 401 — и страница показывалась голым HTML
  // без стилей и без единого работающего элемента.
  it('стили и скрипт отдаются без токена', async () => {
    for (const asset of ['/style.css', '/app.js']) {
      const response = await fetch(`${base()}${asset}`);
      expect(response.status, `${asset} должен отдаваться без токена`).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(100);
    }
  });

  it('у статики корректный тип содержимого', async () => {
    expect((await fetch(`${base()}/style.css`)).headers.get('content-type')).toContain('text/css');
    expect((await fetch(`${base()}/app.js`)).headers.get('content-type')).toContain('javascript');
  });
});

describe('§16.6: пути из запроса не читаются вне рабочего каталога', () => {
  it('отказывает в выдаче произвольного системного файла', async () => {
    const target = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
    const response = await get(`/api/media?path=${encodeURIComponent(target)}`);
    expect(response.status).toBe(403);
    expect((await asBody(response)).error).toContain('вне рабочего каталога');
  });

  it('отказывает при выходе вверх по дереву', async () => {
    const target = path.resolve(process.cwd(), '.dubpipe', '..', '..', 'secret.txt');
    const response = await get(`/api/media?path=${encodeURIComponent(target)}`);
    expect(response.status).toBe(403);
  });

  it('не отдаёт файлы вне каталога статики', async () => {
    const response = await fetch(`${base()}/../package.json?token=${server.token}`);
    expect([400, 403, 404]).toContain(response.status);
  });
});

describe('FR-U2: выбор папки и список видео', () => {
  it('показывает диски, когда каталог не указан', async () => {
    const data = await asBody(await get('/api/browse'));
    expect(Array.isArray(data.entries)).toBe(true);
    if (process.platform === 'win32') {
      expect(data.entries.length).toBeGreaterThan(0);
      expect(data.entries.every((entry: { isDir: boolean }) => entry.isDir)).toBe(true);
    }
  });

  it('перечисляет только папки и медиафайлы', async () => {
    const target = path.resolve(process.cwd(), 'tests', 'fixtures');
    const data = await asBody(await get(`/api/browse?dir=${encodeURIComponent(target)}`));
    expect(data.dir).toBe(target);
    // В каталоге есть golden.json — он не медиа и показываться не должен.
    const names = data.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain('sample.mp4');
    expect(names).not.toContain('golden.json');
  });

  it('сообщает о недоступном каталоге понятной ошибкой', async () => {
    const response = await get(`/api/browse?dir=${encodeURIComponent('C:/нет-такой-папки-12345')}`);
    expect(response.status).toBe(400);
    expect((await asBody(response)).error).toContain('не удалось прочитать каталог');
  });

  it('отклоняет несуществующую рабочую папку', async () => {
    const response = await fetch(`${base()}/api/workdir?token=${server.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'C:/нет-такой-папки-12345' }),
    });
    expect(response.status).toBe(400);
    expect((await asBody(response)).error).toContain('папка не найдена');
  });

  it('запоминает выбранную папку и отдаёт её содержимое', async () => {
    const target = path.resolve(process.cwd(), 'tests', 'fixtures');
    const saved = await fetch(`${base()}/api/workdir?token=${server.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: target }),
    });
    expect(saved.status).toBe(200);

    const library = await asBody(await get('/api/library'));
    expect(library.workingDir).toBe(target);
    const sample = library.files.find((file: { name: string }) => file.name === 'sample.mp4');
    expect(sample).toBeDefined();
    expect(Array.isArray(sample.stages)).toBe(true);
  });

  it('без выбранной папки библиотека пуста, а не сломана', async () => {
    await fetch(`${base()}/api/workdir?token=${server.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: null }),
    });
    const library = await asBody(await get('/api/library'));
    expect(library.workingDir).toBeNull();
    expect(library.files).toEqual([]);
  });
});

describe('§16: состояние и справочники', () => {
  it('возвращает версию, стадии и правовое предупреждение', async () => {
    const data = await asBody(await get('/api/state'));
    expect(data.version).toBeTruthy();
    expect(data.stages).toHaveLength(7);
    expect(data.stages[0]).toEqual({ id: 's1', title: expect.any(String) });
    expect(data.legalNotice).toContain('личного просмотра');
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it('сообщает состояние внешних компонентов', async () => {
    const data = await asBody(await get('/api/environment'));
    expect(data.tools.length).toBeGreaterThan(0);
    expect(data.tools[0]).toHaveProperty('installHint');
    expect(data).toHaveProperty('python');
    expect(data).toHaveProperty('keySet');
  });

  it('не раскрывает значение ключа, только факт его наличия', async () => {
    const text = await (await get('/api/environment')).text();
    expect(text).not.toContain(process.env['KILO_API_KEY'] ?? '§нет§');
    expect(text).toMatch(/"keySet":(true|false)/);
  });

  it('перечисляет голоса синтеза', async () => {
    const data = await asBody(await get('/api/voices'));
    expect(data.voices.length).toBeGreaterThan(0);
    expect(data.defaultVoice).toBeTruthy();
  });

  it('отдаёт текст конфигурации', async () => {
    const data = await asBody(await get('/api/config'));
    expect(data.text).toContain('profile');
    expect(data.parsed.asr.engine).toBe('whisper-cpp');
  });
});

describe('FR-U7: готовность к работе', () => {
  it('перечисляет требования и говорит, что именно не выполнится', async () => {
    const data = await asBody(await get('/api/readiness'));
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeGreaterThan(3);
    expect(typeof data.summary).toBe('string');

    for (const item of data.items) {
      expect(['ok', 'warn', 'blocked']).toContain(item.state);
      // Если чего-то не хватает, обязано быть сказано, что из-за этого сломается.
      if (item.state !== 'ok') expect(item.blocks).toBeTruthy();
    }
  });

  it('ключ API — отдельное требование с понятным объяснением', async () => {
    const data = await asBody(await get('/api/readiness'));
    const key = data.items.find((item: { id: string }) => item.id === 'apikey');
    expect(key).toBeDefined();
    expect(key.title).toContain('Ключ');
    // Значение ключа не раскрывается, только факт наличия.
    expect(JSON.stringify(key)).not.toContain(process.env['KILO_API_KEY'] ?? '§нет§');
  });

  it('загрузка компонентов отвечает сразу, не дожидаясь окончания', async () => {
    const started = Date.now();
    const response = await fetch(`${base()}/api/environment/fetch?token=${server.token}`, { method: 'POST' });
    const body = await asBody(response);
    // Либо загрузка началась (202), либо качать нечего (200) — но ответ
    // приходит мгновенно: ход загрузки идёт через поток событий.
    expect([200, 202]).toContain(response.status);
    expect(typeof body.started).toBe('boolean');
    if (!body.started) expect(body.note).toContain('уже загружено');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('FR-U6: настройки как форма', () => {
  const configPath = path.resolve(process.cwd(), 'config.yaml');
  const secretsPath = path.resolve(process.cwd(), '.dubpipe', 'secrets.json');
  let hadConfig = false;
  let originalConfig = '';
  let hadSecrets = false;

  beforeAll(() => {
    hadConfig = existsSync(configPath);
    if (hadConfig) originalConfig = readFileSync(configPath, 'utf8');
    hadSecrets = existsSync(secretsPath);
  });

  afterAll(() => {
    // Тест не должен ни оставлять созданный им config.yaml, ни трогать чужой.
    if (hadConfig) writeFileSync(configPath, originalConfig, 'utf8');
    else if (existsSync(configPath)) unlinkSync(configPath);
    if (!hadSecrets && existsSync(secretsPath)) unlinkSync(secretsPath);
  });

  it('сохраняет отдельное значение и оставляет комментарии файла', async () => {
    const response = await fetch(`${base()}/api/config/values?token=${server.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { 'translate.batch_size': 12 } }),
    });
    expect(response.status).toBe(200);
    const body = await asBody(response);
    expect(body.parsed.translate.batch_size).toBe(12);

    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('batch_size: 12');
    // Комментарии из примера переживают точечную правку.
    expect(text).toContain('# --- S3. Перевод');
  });

  it('отклоняет недопустимое значение, называя поле', async () => {
    const response = await fetch(`${base()}/api/config/values?token=${server.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { 'translate.batch_size': 999 } }),
    });
    expect(response.status).toBe(400);
    expect((await asBody(response)).error).toContain('translate.batch_size');
  });

  it('показывает ключ только по краям', async () => {
    const original = process.env['KILO_API_KEY'];
    const data = await asBody(await get('/api/key'));
    expect(typeof data.set).toBe('boolean');
    if (original && original.length > 12) {
      expect(data.masked).not.toBe(original);
      expect(data.masked.length).toBeLessThan(original.length);
      expect(JSON.stringify(data)).not.toContain(original);
    }
  });

  it('токен Hugging Face показывается только по краям и не попадает в ответы', async () => {
    const original = process.env['HF_TOKEN'];
    const token = 'hf_' + 'QwErTy'.repeat(6);
    const saved = await fetch(`${base()}/api/hf-token?token=${server.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(saved.status).toBe(200);
    const body = await asBody(saved);
    expect(body.set).toBe(true);
    expect(body.masked).not.toBe(token);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(asBody(await get('/api/readiness')))).not.toContain(token);

    const removed = await fetch(`${base()}/api/hf-token?token=${server.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: null }),
    });
    expect((await asBody(removed)).set).toBe(false);
    if (original) process.env['HF_TOKEN'] = original;
    else delete process.env['HF_TOKEN'];
  });

  it('проверка ключа без ключа отвечает понятно, а не падает', async () => {
    const original = process.env['KILO_API_KEY'];
    delete process.env['KILO_API_KEY'];
    try {
      const response = await fetch(`${base()}/api/key/check?token=${server.token}`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = await asBody(response);
      expect(body.ok).toBe(false);
      expect(body.reason).toContain('не задан');
    } finally {
      if (original !== undefined) process.env['KILO_API_KEY'] = original;
    }
  });
});

describe('§16: валидация правок конфигурации', () => {
  it('отклоняет некорректное значение с объяснением', async () => {
    const response = await fetch(`${base()}/api/config?token=${server.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'alignment:\n  max_tempo: 9\n' }),
    });
    expect(response.status).toBe(400);
    const body = await asBody(response);
    expect(body.error).toContain('alignment.max_tempo');
  });
});

describe('§16: задачи', () => {
  it('требует указать вход', async () => {
    const response = await fetch(`${base()}/api/jobs?token=${server.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('сообщает о неизвестном маршруте понятной ошибкой', async () => {
    const response = await get('/api/nonexistent');
    expect(response.status).toBe(404);
    expect((await asBody(response)).error).toContain('нет обработчика');
  });
});

/**
 * Экран готовности должен спрашивать у того движка, которым будут озвучивать.
 *
 * Пока он всегда проверял piper, при движке silero он уверенно сообщал «нет
 * голоса» о голосе, которого у этого движка не бывает, и предлагал в выборе
 * имена из чужого каталога. Проверяется на поднятом сервере, а не чтением кода:
 * ровно здесь чтение однажды и подвело.
 */
describe('FR-U7: готовность спрашивает у выбранного движка синтеза', () => {
  /*
   * Свой файл настроек во временном каталоге, а не общий config.yaml проекта.
   *
   * Файлы тестов vitest выполняет параллельно, и подмена общего файла на время
   * блока задевала соседей: на CI из-за неё по таймауту отваливались проверки
   * провижининга и готовности, читающие тот же файл. Рабочий каталог тоже
   * отдельный — иначе готовность смотрела бы на программы проекта.
   */
  let root = '';
  let silero: UiServerHandle;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'dubpipe-ui-silero-'));
    const configPath = path.join(root, 'config.yaml');
    const lines = [
      'tts:',
      '  engine: silero',
      '  default_voice: ru_zhadyra',
      'cache:',
      `  dir: ${JSON.stringify(path.join(root, 'cache'))}`,
      '',
    ];
    writeFileSync(configPath, lines.join('\n'), 'utf8');
    silero = await startUiServer({ port: 0, configPath });
  }, 60_000);

  afterAll(async () => {
    await silero?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const ask = async (route: string): Promise<ResponseBody> =>
    (await (await fetch(`http://127.0.0.1:${silero.port}${route}?token=${silero.token}`)).json()) as ResponseBody;

  it('в готовности стоит silero, а не piper', async () => {
    const data = await ask('/api/readiness');
    const ids = data.items.map((item: { id: string }) => item.id);
    expect(ids).toContain('silero');
    expect(ids).not.toContain('piper');
  });

  it('пункт про синтез не нарушает общего правила: не в порядке — сказано, что сломается', async () => {
    const data = await ask('/api/readiness');
    const tts = data.items.find((item: { id: string }) => item.id === 'silero');
    expect(['ok', 'warn', 'blocked']).toContain(tts.state);
    if (tts.state !== 'ok') expect(tts.blocks).toBeTruthy();
  });

  it('в выборе голоса — имена этого движка, а не чужого каталога', async () => {
    const data = await ask('/api/voices');
    const names = data.voices.map((voice: { name: string }) => voice.name);
    expect(names).toContain('ru_zhadyra');
    expect(names.every((name: string) => !name.startsWith('ru_RU-'))).toBe(true);
  });
});
