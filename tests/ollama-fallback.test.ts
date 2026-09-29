import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig } from '../src/config/load.js';
import { selectChatClient } from '../src/providers/llm/index.js';

/**
 * Перевод через Ollama, когда в поле модели осталось имя, которого Ollama не
 * знает. Так было после «облако → Ollama» в настройках: поле хранило
 * `~anthropic/claude-haiku-latest`, и перевод падал на «модель не установлена».
 */
describe('модель, которой нет в Ollama', () => {
  let server: http.Server;
  let endpoint = '';

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/api/tags') {
        response.end(JSON.stringify({ models: [{ name: 'gemma4:26b-a4b-it-qat', size: 1 }] }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('переводит запасной моделью и говорит об этом', async () => {
    const config = parseConfig(
      {
        profile: 'offline',
        translate: { model: '~anthropic/claude-haiku-latest', fallback_model: 'gemma4:26b-a4b-it-qat', ollama_endpoint: endpoint },
      },
      'test',
    );
    const selection = await selectChatClient(config);
    expect(selection.client.model).toBe('gemma4:26b-a4b-it-qat');
    expect(selection.warnings.map((item) => (typeof item === 'string' ? item : item.key))).toContain('warn.llm.modelMissing');
  });

  it('без годной запасной — внятная ошибка, а не молчание', async () => {
    const config = parseConfig(
      { profile: 'offline', translate: { model: 'нет-такой', fallback_model: 'и-такой-нет', ollama_endpoint: endpoint } },
      'test',
    );
    await expect(selectChatClient(config)).rejects.toThrow(/не установлена/);
  });
});
