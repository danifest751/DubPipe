import { describe, it, expect } from 'vitest';
import { makeSegment, type Segment } from '../src/core/types.js';
import { parseConfig } from '../src/config/load.js';
import { translateSegments } from '../src/stages/s3-translate.js';
import type { ChatClient, ChatMessage, ChatResult } from '../src/providers/llm/types.js';

/**
 * Перевод — единственная дорогая стадия, и обрыв на середине стоил всей суммы
 * заново: реплики она пишет после каждого пакета, но при перезапуске начинала
 * с первого. На восьмом эпизоде прогон прервался на 47-м пакете из 65, и
 * повторный запуск оплатил бы 134 уже переведённые реплики вторично.
 */

const line = (id: number, en: string, ru: string | null = null): Segment =>
  makeSegment({ id, start: id * 4, end: id * 4 + 3, text_en: en, text_ru: ru });

/** Считает запросы и переводит «слово → слово-ru». */
function countingClient(): ChatClient & { requests: number; ids: number[] } {
  const client = {
    name: 'тест',
    model: 'тест',
    requests: 0,
    ids: [] as number[],
    available: async () => true,
    async complete(messages: ChatMessage[]): Promise<ChatResult> {
      client.requests++;
      const asked = [...messages[1]!.content.matchAll(/"id":(\d+)/g)].map((match) => Number(match[1]));
      client.ids.push(...asked);
      return {
        text: JSON.stringify({ items: asked.map((id) => ({ id, text_ru: `перевод ${id}` })) }),
        usage: { promptTokens: 10, completionTokens: 10, cost: 0 },
      };
    },
  };
  return client;
}

const config = parseConfig({ translate: { batch_size: 2, fit_length_pass: false, review: { enabled: false } } }, 'тест');

describe('перевод продолжается после обрыва', () => {
  it('пакет, переведённый прошлым прогоном, не переводится заново', async () => {
    const segments = [
      line(0, 'one', 'один'),
      line(1, 'two', 'два'),
      line(2, 'three'),
      line(3, 'four'),
    ];
    const client = countingClient();
    const run = await translateSegments(client, config, segments, { reusable: new Set([0, 1]) });

    expect(client.requests).toBe(1);
    expect(client.ids).toEqual([2, 3]);
    expect(run.reused).toBe(2);
    // Готовый перевод остался как был, недостающий появился.
    expect(run.segments.map((segment) => segment.text_ru)).toEqual(['один', 'два', 'перевод 2', 'перевод 3']);
  });

  it('без списка годных переводится всё: смена настроек должна переводить заново', async () => {
    const segments = [line(0, 'one', 'один'), line(1, 'two', 'два'), line(2, 'three'), line(3, 'four')];
    const client = countingClient();
    const run = await translateSegments(client, config, segments, {});
    expect(client.requests).toBe(2);
    expect(run.reused).toBe(0);
    expect(run.segments[0]!.text_ru).toBe('перевод 0');
  });

  it('готовыми объявляются только реплики этого прогона и взятые из прерванного', async () => {
    // Записать «готово» про чужой перевод — значит при следующем запуске
    // объявить годным то, что сделано другими настройками.
    const segments = [line(0, 'one', 'старый перевод'), line(1, 'two'), line(2, 'three'), line(3, 'four')];
    const client = countingClient();
    const seen: number[][] = [];
    await translateSegments(client, config, segments, {
      onBatch: (_done, _total, _segments, settled) => {
        seen.push(settled);
      },
    });
    // Реплика 0 переведена заново — она в списке; чужой перевод туда не попал
    // в обход перевода.
    expect(seen[0]).toEqual([0, 1]);
    expect(seen[1]).toEqual([0, 1, 2, 3]);
  });

  it('годной считается только реплика, у которой перевод и правда есть', async () => {
    // В списке значится пустая реплика — пакет всё равно переводится.
    const segments = [line(0, 'one', 'один'), line(1, 'two'), line(2, 'three'), line(3, 'four')];
    const client = countingClient();
    await translateSegments(client, config, segments, { reusable: new Set([0, 1]) });
    expect(client.ids).toEqual([0, 1, 2, 3]);
  });
});
