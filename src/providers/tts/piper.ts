import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { DubConfig } from '../../config/schema.js';
import { StageError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import type { Workspace } from '../../core/workspace.js';
import { run } from '../../util/exec.js';
import { provisionTool } from '../../util/tools.js';
import { requireTool } from '../../util/tools.js';
import { wavDuration } from '../../util/wav.js';
import { ensureVoice } from './voices.js';
import type { SynthesisRequest, SynthesisResult, TtsProvider } from './index.js';

/**
 * Local speech synthesis with piper (SPEC §15.1). CPU only, no Python, no keys.
 * piper renders at the voice's native rate (22.05 kHz for the medium voices),
 * so every clip is resampled to the configured rate (SPEC FR-5).
 */
export class PiperProvider implements TtsProvider {
  readonly name = 'piper (локально, CPU)';

  constructor(
    private readonly workspace: Workspace,
    private readonly config: DubConfig,
  ) {}

  async listVoices(): Promise<string[]> {
    const { RUSSIAN_VOICES } = await import('./voices.js');
    return RUSSIAN_VOICES.map((voice) => voice.name);
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const binary = (await provisionTool('piper', this.workspace.toolsDir)).path;
    const ffmpeg = await requireTool('ffmpeg', this.workspace.toolsDir);
    const voice = await ensureVoice(request.voice, this.workspace.modelsDir);

    const raw = `${request.outputPath}.raw.wav`;
    try {
      await run(binary, ['-m', voice.modelPath, '-c', voice.configPath, '-f', raw, '--sentence_silence', '0', '-q'], {
        input: request.text,
        timeoutMs: 300_000,
        captureStdout: false,
      });
    } catch (cause) {
      throw new StageError('s5', `не удалось синтезировать реплику ${request.id}: ${(cause as Error).message}`, {
        artifact: raw,
        cause,
      });
    }

    // Bring every clip to one rate and layout before mixing.
    await run(
      ffmpeg,
      ['-y', '-v', 'error', '-i', raw, '-ar', String(this.config.tts.sample_rate), '-ac', '1', '-acodec', 'pcm_s16le', request.outputPath],
      { timeoutMs: 120_000 },
    );
    await rm(raw, { force: true });

    const duration = await wavDuration(request.outputPath);
    log.debug(`реплика ${request.id}: ${duration.toFixed(2)} с голосом ${request.voice}`);
    return { path: request.outputPath, durationSeconds: duration };
  }

  /** Short sample used by `dub voices list --demo`. */
  async sample(voice: string, text: string, outputPath: string): Promise<SynthesisResult> {
    return await this.synthesize({ id: -1, text, voice, outputPath: path.resolve(outputPath) });
  }
}
