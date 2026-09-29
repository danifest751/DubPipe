import type { DubConfig } from '../../config/schema.js';
import { isCancelled } from '../../core/cancel.js';
import { StageError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import type { Workspace } from '../../core/workspace.js';
import type { RawSegment } from '../../stages/s2-segments.js';
import { warn, type WordTiming, type StageWarning } from '../../core/types.js';
import { onServer, serverUnavailable } from '../remote/server.js';
import { FasterWhisperProvider } from './faster-whisper.js';
import { WhisperCppProvider } from './whispercpp.js';

export interface AsrResult {
  segments: RawSegment[];
  /** Flat word timings on the original timeline, used for boundary refinement. */
  words: WordTiming[];
  provider: string;
  warnings: StageWarning[];
}

export interface AsrProvider {
  readonly name: string;
  transcribe(audioPath: string): Promise<AsrResult>;
}

/** Движок распознавания на этом компьютере. */
function createLocalProvider(workspace: Workspace, config: DubConfig): AsrProvider {
  switch (config.asr.engine) {
    case 'whisper-cpp':
      return new WhisperCppProvider(workspace, config);
    case 'faster-whisper':
      return new FasterWhisperProvider(workspace, config, 'local');
    case 'kilo-gateway':
      // Guarded in config validation as well; kept here so the reason survives
      // if the schema is ever relaxed (SPEC §3.1.1).
      throw new StageError('s2', 'Kilo Gateway не возвращает таймкоды и не годится для S2 (ТЗ §3.1.1)', {
        hints: ['Используйте asr.engine: whisper-cpp'],
      });
  }
}

/**
 * Распознавание на сервере с запасным путём здесь.
 *
 * Сервер не ответил или упал посреди записи — прогон не останавливается:
 * распознаёт локальный движок, а в отчёте остаётся предупреждение, почему
 * фильм считался дольше обычного.
 */
class ServerFirstProvider implements AsrProvider {
  name: string;

  constructor(
    private readonly remote: FasterWhisperProvider,
    private readonly local: () => AsrProvider,
    private readonly config: DubConfig,
  ) {
    this.name = remote.name;
  }

  async transcribe(audioPath: string): Promise<AsrResult> {
    let reason = await serverUnavailable(this.config, 'asr');
    if (reason === null) {
      try {
        const result = await this.remote.transcribe(audioPath);
        this.name = result.provider;
        return result;
      } catch (error) {
        if (isCancelled(error)) throw error;
        reason = (error as Error).message;
      }
    }
    if (!this.config.server.fallback_local) {
      throw new StageError('s2', `распознавание на сервере не выполнено: ${reason}`, {
        hints: ['Проверьте, что сервис dubpipe-worker запущен на сервере', 'Либо разрешите считать здесь: server.fallback_local: true'],
      });
    }
    log.warn(`распознавание на сервере недоступно (${reason}), считаю на этом компьютере`);
    const local = this.local();
    const result = await local.transcribe(audioPath);
    this.name = result.provider;
    return {
      ...result,
      warnings: [
        warn('warn.server.fallback', `Сервер не распознал запись (${reason}); распознано на этом компьютере — медленнее`, {
          stage: 'S2',
          reason,
        }),
        ...result.warnings,
      ],
    };
  }
}

export function createAsrProvider(workspace: Workspace, config: DubConfig): AsrProvider {
  if (onServer(config, 'asr')) {
    return new ServerFirstProvider(
      new FasterWhisperProvider(workspace, config, 'server'),
      () => createLocalProvider(workspace, config),
      config,
    );
  }
  return createLocalProvider(workspace, config);
}
