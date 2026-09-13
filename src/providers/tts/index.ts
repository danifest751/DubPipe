import type { DubConfig } from '../../config/schema.js';
import { StageError } from '../../core/errors.js';
import type { Workspace } from '../../core/workspace.js';
import { PiperProvider } from './piper.js';

export * from './voices.js';

export interface SynthesisRequest {
  id: number;
  text: string;
  voice: string;
  outputPath: string;
}

export interface SynthesisResult {
  path: string;
  durationSeconds: number;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
  listVoices(): Promise<string[]>;
}

export function createTtsProvider(workspace: Workspace, config: DubConfig): TtsProvider {
  switch (config.tts.engine) {
    case 'piper':
      return new PiperProvider(workspace, config);
    case 'edge-tts':
      throw new StageError('s5', 'Движок edge-tts пока не реализован', {
        hints: ['Используйте tts.engine: piper — он работает офлайн и без ключей'],
      });
    case 'kilo-gateway':
      // Also rejected by config validation; kept so the reason survives.
      throw new StageError('s5', 'Синтез через Kilo Gateway непригоден для дубляжа (ТЗ §3.1.2)', {
        hints: ['Используйте tts.engine: piper'],
      });
  }
}
