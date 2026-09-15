import type { DubConfig } from '../../config/schema.js';
import { StageError } from '../../core/errors.js';
import type { Workspace } from '../../core/workspace.js';
import type { RawSegment } from '../../stages/s2-segments.js';
import type { WordTiming } from '../../core/types.js';
import { WhisperCppProvider } from './whispercpp.js';

export interface AsrResult {
  segments: RawSegment[];
  /** Flat word timings on the original timeline, used for boundary refinement. */
  words: WordTiming[];
  provider: string;
  warnings: string[];
}

export interface AsrProvider {
  readonly name: string;
  transcribe(audioPath: string): Promise<AsrResult>;
}

export function createAsrProvider(workspace: Workspace, config: DubConfig): AsrProvider {
  switch (config.asr.engine) {
    case 'whisper-cpp':
      return new WhisperCppProvider(workspace, config);
    case 'kilo-gateway':
      // Guarded in config validation as well; kept here so the reason survives
      // if the schema is ever relaxed (SPEC §3.1.1).
      throw new StageError('s2', 'Kilo Gateway не возвращает таймкоды и не годится для S2 (ТЗ §3.1.1)', {
        hints: ['Используйте asr.engine: whisper-cpp'],
      });
  }
}
