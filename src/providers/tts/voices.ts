import { existsSync } from 'node:fs';
import path from 'node:path';
import { downloadFile } from '../../util/download.js';
import { StageError } from '../../core/errors.js';

/**
 * Piper voice management (SPEC FR-5). Voices are ONNX files fetched on first use
 * into the workspace, so no system install and no Python are involved.
 */

const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

export interface VoiceInfo {
  name: string;
  language: string;
  speaker: string;
  quality: string;
  gender: 'ж' | 'м' | '—';
  note: string;
}

/** Russian voices known to exist upstream; any other name is still accepted. */
export const RUSSIAN_VOICES: VoiceInfo[] = [
  { name: 'ru_RU-irina-medium', language: 'ru_RU', speaker: 'irina', quality: 'medium', gender: 'ж', note: 'ровная дикторская подача' },
  { name: 'ru_RU-denis-medium', language: 'ru_RU', speaker: 'denis', quality: 'medium', gender: 'м', note: 'нейтральный мужской' },
  { name: 'ru_RU-dmitri-medium', language: 'ru_RU', speaker: 'dmitri', quality: 'medium', gender: 'м', note: 'мягче и ниже, чем denis' },
  { name: 'ru_RU-ruslan-medium', language: 'ru_RU', speaker: 'ruslan', quality: 'medium', gender: 'м', note: 'более разговорный' },
];

/**
 * Derives the upstream path from the voice name: `ru_RU-irina-medium` lives at
 * `ru/ru_RU/irina/medium/`. The naming scheme is the catalogue's own, so no
 * hard-coded table is needed for voices beyond the known list.
 */
export function voiceUrlPath(voice: string): string {
  const match = /^([a-z]{2})_([A-Z]{2})-(.+)-([a-z_]+)$/.exec(voice);
  if (!match) {
    throw new StageError('s5', `Не разобрать имя голоса «${voice}»`, {
      hints: ['Ожидается формат вида ru_RU-irina-medium', 'Список: dub voices list'],
    });
  }
  const [, lang, region, speaker, quality] = match;
  return `${lang}/${lang}_${region}/${speaker}/${quality}/${voice}`;
}

export interface ResolvedVoice {
  name: string;
  modelPath: string;
  configPath: string;
}

/** Downloads the voice if absent and returns local paths to its two files. */
export async function ensureVoice(voice: string, modelsDir: string): Promise<ResolvedVoice> {
  const dir = path.join(modelsDir, 'voices');
  const modelPath = path.join(dir, `${voice}.onnx`);
  const configPath = path.join(dir, `${voice}.onnx.json`);
  const remote = `${VOICE_BASE}/${voiceUrlPath(voice)}`;

  if (!existsSync(modelPath)) {
    await downloadFile(`${remote}.onnx`, modelPath, {
      label: `голос ${voice}`,
      minBytes: 1_000_000,
      timeoutMs: 900_000,
    });
  }
  if (!existsSync(configPath)) {
    await downloadFile(`${remote}.onnx.json`, configPath, {
      label: `настройки голоса ${voice}`,
      minBytes: 100,
      timeoutMs: 120_000,
    });
  }

  return { name: voice, modelPath, configPath };
}

/** Voice for a speaker, falling back to the default (SPEC FR-5). */
export function voiceForSpeaker(
  speaker: string,
  voiceMap: Record<string, string>,
  defaultVoice: string,
): string {
  return voiceMap[speaker] ?? defaultVoice;
}
