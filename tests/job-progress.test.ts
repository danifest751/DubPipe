import { describe, it, expect } from 'vitest';
import { applyLogRecord, finishStages, type JobStage } from '../src/ui/job-progress.js';
import { log, type LogRecord } from '../src/core/logger.js';

const stages = (): JobStage[] => [
  { id: 's1', title: 'Приём', state: 'pending' },
  { id: 's2', title: 'Распознавание', state: 'pending' },
  { id: 's3', title: 'Перевод', state: 'pending' },
];

const banner = (id: string, at: string): LogRecord => ({
  level: 'info',
  kind: 'stage',
  text: id,
  at,
  stage: { id, index: 1, total: 3, title: id },
});

describe('FR-U3: ход стадий задачи', () => {
  it('баннер стадии запускает её и закрывает предыдущую со временем', () => {
    const list = stages();
    expect(applyLogRecord(list, banner('s1', '2026-01-01T00:00:00.000Z'))).toBe(true);
    expect(list[0]!.state).toBe('running');
    expect(list[0]!.startedAt).toBe('2026-01-01T00:00:00.000Z');

    applyLogRecord(list, banner('s2', '2026-01-01T00:01:30.000Z'));
    expect(list[0]!.state).toBe('done');
    expect(list[0]!.durationMs).toBe(90_000);
    expect(list[1]!.state).toBe('running');
  });

  it('запись о ходе попадает в текущую стадию и стирается при переходе', () => {
    const list = stages();
    applyLogRecord(list, banner('s2', '2026-01-01T00:00:00.000Z'));
    const record: LogRecord = {
      level: 'debug',
      kind: 'progress',
      text: 'распознавание 42%',
      at: '2026-01-01T00:00:10.000Z',
      progress: { percent: 42, detail: 'распознавание 42%' },
    };
    expect(applyLogRecord(list, record)).toBe(true);
    expect(list[1]!.progress?.percent).toBe(42);
    expect(list[1]!.progress?.at).toBe('2026-01-01T00:00:10.000Z');

    applyLogRecord(list, banner('s3', '2026-01-01T00:00:20.000Z'));
    expect(list[1]!.progress).toBeUndefined();
  });

  it('ход без текущей стадии и обычные строки ничего не меняют', () => {
    const list = stages();
    const record: LogRecord = { level: 'debug', kind: 'progress', text: 'x', at: 'now', progress: { percent: 1, detail: 'x' } };
    expect(applyLogRecord(list, record)).toBe(false);
    expect(applyLogRecord(list, { level: 'info', kind: 'step', text: 'шаг', at: 'now' })).toBe(false);
  });

  it('по окончании все стадии закрываются, при ошибке текущая возвращается в ожидание', () => {
    const done = stages();
    applyLogRecord(done, banner('s2', '2026-01-01T00:00:00.000Z'));
    finishStages(done, '2026-01-01T00:00:05.000Z', 'done');
    expect(done.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(done[1]!.durationMs).toBe(5000);

    const failed = stages();
    applyLogRecord(failed, banner('s2', '2026-01-01T00:00:00.000Z'));
    finishStages(failed, '2026-01-01T00:00:05.000Z', 'pending');
    expect(failed[1]!.state).toBe('pending');
  });

  it('log.progress считает процент из счётчика и обрезает выход за 0–100', () => {
    const seen: LogRecord[] = [];
    const stop = log.subscribe((record) => { if (record.kind === 'progress') seen.push(record); });
    log.progress('пакеты', null, { done: 3, total: 12 });
    log.progress('хвост', 140);
    log.progress('неизвестно', null);
    stop();
    expect(seen.map((r) => r.progress?.percent)).toEqual([25, 100, null]);
    expect(seen[0]!.progress?.done).toBe(3);
    expect(seen[0]!.level).toBe('debug');
  });
});
