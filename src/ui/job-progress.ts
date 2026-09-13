import type { LogRecord, StageProgress } from '../core/logger.js';
import type { StageId } from '../core/types.js';

/**
 * Состояние стадий задачи для интерфейса: не только «ждёт / идёт / готово»,
 * но и ход текущей стадии со временем. Без этого на долгих стадиях (распознавание,
 * диаризация — минуты) непонятно, жив ли процесс.
 */

export interface JobStage {
  id: StageId;
  title: string;
  state: 'pending' | 'running' | 'done';
  provider?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  progress?: StageProgress & { at: string };
}

/** Применяет запись журнала к стадиям; возвращает true, если что-то изменилось. */
export function applyLogRecord(stages: JobStage[], record: LogRecord, now: string = record.at): boolean {
  if (record.kind === 'stage' && record.stage) {
    let changed = false;
    for (const stage of stages) {
      if (stage.id === record.stage.id) {
        stage.state = 'running';
        stage.startedAt = now;
        delete stage.progress;
        changed = true;
      } else if (stage.state === 'running') {
        finishStage(stage, now);
        changed = true;
      }
    }
    return changed;
  }

  if (record.kind === 'progress' && record.progress) {
    const running = stages.find((stage) => stage.state === 'running');
    if (!running) return false;
    running.progress = { ...record.progress, at: now };
    return true;
  }

  return false;
}

/** Завершает все незакрытые стадии — когда конвейер закончил или упал. */
export function finishStages(stages: JobStage[], now: string, state: 'done' | 'pending' = 'done'): void {
  for (const stage of stages) {
    if (stage.state === 'running') {
      if (state === 'done') finishStage(stage, now);
      else stage.state = 'pending';
    } else if (state === 'done' && stage.state === 'pending') {
      stage.state = 'done';
    }
  }
}

function finishStage(stage: JobStage, now: string): void {
  stage.state = 'done';
  stage.finishedAt = now;
  if (stage.startedAt) stage.durationMs = Math.max(0, Date.parse(now) - Date.parse(stage.startedAt));
  delete stage.progress;
}
