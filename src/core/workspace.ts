import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { normalizeOverrides, type ProjectOverrides, type SpeakerProfiles } from './overrides.js';
import type { Cue } from '../stages/subtitles.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DubConfig } from '../config/schema.js';
import { hashInput, shortHash, hashObject } from '../util/hash.js';
import { STAGE_IDS, type Meta, type Segment, type StageId } from './types.js';
import { log } from './logger.js';

export const TOOL_VERSION = '1.0.0';

/**
 * Per-input working directory holding every stage artifact, so a crashed run
 * resumes instead of restarting (SPEC §7).
 *
 * Layout:  <cache.dir>/<input-hash>/{meta.json,segments.json,state.json,audio.wav,tts/,aligned/}
 * Shared:  <cache.dir>/{tools,models}   — provisioned binaries and weights (SPEC §15.3)
 */
export class Workspace {
  readonly root: string;
  readonly dir: string;
  readonly inputHash: string;
  readonly input: string;

  private constructor(root: string, dir: string, input: string, inputHash: string) {
    this.root = root;
    this.dir = dir;
    this.input = input;
    this.inputHash = inputHash;
  }

  static async open(input: string, config: DubConfig): Promise<Workspace> {
    const root = path.resolve(process.cwd(), config.cache.dir);
    const inputHash = await hashInput(input);
    const dir = path.join(root, shortHash(inputHash));
    const workspace = new Workspace(root, dir, input, inputHash);
    await workspace.ensure();
    return workspace;
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.toolsDir, { recursive: true });
    await mkdir(this.modelsDir, { recursive: true });
  }

  get toolsDir(): string {
    return path.join(this.root, 'tools');
  }

  get modelsDir(): string {
    return path.join(this.root, 'models');
  }

  file(name: string): string {
    return path.join(this.dir, name);
  }

  async subdir(name: string): Promise<string> {
    const target = path.join(this.dir, name);
    await mkdir(target, { recursive: true });
    return target;
  }

  get metaPath(): string {
    return this.file('meta.json');
  }

  get segmentsPath(): string {
    return this.file('segments.json');
  }

  private get statePath(): string {
    return this.file('state.json');
  }

  async readJson<T>(filePath: string): Promise<T | null> {
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as T;
    } catch (error) {
      log.warn(`Повреждён артефакт ${filePath}: ${(error as Error).message}; будет пересоздан`);
      return null;
    }
  }

  async writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  readMeta(): Promise<Meta | null> {
    return this.readJson<Meta>(this.metaPath);
  }

  writeMeta(meta: Meta): Promise<void> {
    return this.writeJson(this.metaPath, meta);
  }

  readSegments(): Promise<Segment[] | null> {
    return this.readJson<Segment[]>(this.segmentsPath);
  }

  /** Правки этого видео поверх настроек: голоса спикеров, громкости (режим просмотра). */
  get overridesPath(): string {
    return this.file('overrides.json');
  }

  async readOverrides(): Promise<ProjectOverrides> {
    return normalizeOverrides(await this.readJson<unknown>(this.overridesPath));
  }

  writeOverrides(overrides: ProjectOverrides): Promise<void> {
    return this.writeJson(this.overridesPath, normalizeOverrides(overrides));
  }

  /**
   * Правленые вручную титры; пусто — берутся из реплик. Хранятся по роли
   * (оригинал или перевод), а не по коду языка: смена языка оригинала
   * в настройках не должна терять ручные правки.
   */
  cuesPath(kind: 'source' | 'target'): string {
    return this.file(`cues.${kind}.json`);
  }

  readCues(kind: 'source' | 'target'): Promise<Cue[] | null> {
    return this.readJson<Cue[]>(this.cuesPath(kind));
  }

  writeCues(kind: 'source' | 'target', cues: Cue[]): Promise<void> {
    return this.writeJson(this.cuesPath(kind), cues);
  }

  /** Профили спикеров (пол голоса по основному тону), считаются на S2. */
  get speakersPath(): string {
    return this.file('speakers.json');
  }

  async readSpeakers(): Promise<SpeakerProfiles> {
    return (await this.readJson<SpeakerProfiles>(this.speakersPath)) ?? {};
  }

  writeSpeakers(profiles: SpeakerProfiles): Promise<void> {
    return this.writeJson(this.speakersPath, profiles);
  }

  writeSegments(segments: Segment[]): Promise<void> {
    return this.writeJson(this.segmentsPath, segments);
  }

  async readState(): Promise<StageState> {
    return (await this.readJson<StageState>(this.statePath)) ?? { fingerprints: {}, segmentsHash: {} };
  }

  async writeState(state: StageState): Promise<void> {
    await this.writeJson(this.statePath, state);
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  /** Removes every per-input workspace but keeps provisioned tools and models. */
  static async clearAll(config: DubConfig): Promise<number> {
    const root = path.resolve(process.cwd(), config.cache.dir);
    if (!existsSync(root)) return 0;
    const entries = await readdir(root, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'tools' || entry.name === 'models') continue;
      await rm(path.join(root, entry.name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
}

export interface StageState {
  fingerprints: Partial<Record<StageId, string>>;
  /** Hash of segments.json as this stage left it, to notice manual edits (SPEC §6). */
  segmentsHash: Partial<Record<StageId, string>>;
}

/** Config subsets that actually influence each stage's output. */
export function stageConfigSlice(stage: StageId, config: DubConfig): unknown {
  switch (stage) {
    case 's1':
      return { input: config.input };
    case 's2':
      return config.asr;
    case 's3':
      // Перевод заказывает длину по месту, отведённому реплике, а место
      // зависит от того, сколько тишины разрешено занять укладке. Без этих
      // полей изменение borrow_silence_ms не перевело бы файл заново.
      return {
        translate: config.translate,
        borrow_silence_ms: config.alignment.borrow_silence_ms,
        gap_ms: config.alignment.gap_ms,
      };
    case 's4':
      return config.separation;
    case 's5':
      return config.tts;
    case 's6':
      return { alignment: config.alignment, chars_per_second: config.translate.chars_per_second };
    case 's7':
      return { mix: config.mix, keep_original_track: config.keep_original_track };
  }
}

/**
 * Stage cache key: input + stage config + previous stage fingerprint + tool
 * version. Chaining the previous fingerprint makes an early-stage change
 * invalidate everything downstream (SPEC §7).
 */
export function stageFingerprint(
  stage: StageId,
  config: DubConfig,
  inputHash: string,
  previous: string | undefined,
): string {
  return hashObject({
    stage,
    tool: TOOL_VERSION,
    input: inputHash,
    config: stageConfigSlice(stage, config),
    previous: previous ?? null,
  });
}

/** Computes fingerprints for every stage in order, chaining each into the next. */
export function computeFingerprints(config: DubConfig, inputHash: string): Record<StageId, string> {
  const result = {} as Record<StageId, string>;
  let previous: string | undefined;
  for (const stage of STAGE_IDS) {
    const fingerprint = stageFingerprint(stage, config, inputHash, previous);
    result[stage] = fingerprint;
    previous = fingerprint;
  }
  return result;
}
