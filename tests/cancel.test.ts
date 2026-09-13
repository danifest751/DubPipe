import { describe, it, expect, afterEach } from 'vitest';
import { CancelledError, cancellation, isCancelled } from '../src/core/cancel.js';
import { run, withRetry } from '../src/util/exec.js';

/** Процесс, который сам не закончится: остановка обязана убить его. */
const sleeper = ['-e', 'setTimeout(() => {}, 30000)'];

afterEach(() => cancellation.end());

describe('§16.4: остановка прогона', () => {
  it('убивает запущенный процесс и отклоняет обещание сразу', async () => {
    cancellation.begin();
    const started = Date.now();
    const pending = run(process.execPath, sleeper, { timeoutMs: 60_000 });
    setTimeout(() => cancellation.abort(), 200);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('после остановки новые процессы не запускаются', async () => {
    cancellation.begin();
    cancellation.abort();
    await expect(run(process.execPath, sleeper)).rejects.toBeInstanceOf(CancelledError);
  });

  it('повторы не спорят с остановкой', async () => {
    cancellation.begin();
    let calls = 0;
    const task = withRetry(
      async () => {
        calls++;
        cancellation.abort();
        throw new Error('сеть');
      },
      { attempts: 5, baseDelayMs: 1 },
    );
    await expect(task).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toBe(1);
  });

  it('сигнал живёт только внутри прогона', () => {
    expect(cancellation.abort()).toBe(false);
    expect(cancellation.signal).toBeNull();
    const signal = cancellation.begin();
    expect(signal.aborted).toBe(false);
    expect(cancellation.abort()).toBe(true);
    expect(cancellation.abort()).toBe(false);
    expect(() => cancellation.throwIfCancelled()).toThrow(CancelledError);
  });

  it('остановка отличается от обычной ошибки', () => {
    expect(isCancelled(new CancelledError())).toBe(true);
    expect(isCancelled(new Error('сеть'))).toBe(false);
    expect(new CancelledError().exitCode).toBe(130);
  });
});
