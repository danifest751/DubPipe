/** Library surface, mirrored by the CLI in src/cli.ts. */
export { loadConfig, parseConfig, initConfig } from './config/load.js';
export { configSchema, type DubConfig, type Profile } from './config/schema.js';
export { runPipeline, stageRange, disabledStages, type PipelineReport } from './core/pipeline.js';
export { Workspace, computeFingerprints, stageFingerprint, TOOL_VERSION } from './core/workspace.js';
export * from './core/types.js';
export * from './core/errors.js';
export { buildSegments, splitLongSegment, refineBoundaries, markOverlaps, isNonSpeech, segmentsSummary, type RawSegment } from './stages/s2-segments.js';
export { buildAtempoChain, dbToLinear } from './util/ffmpeg.js';
export { toSrt, formatTimestamp } from './util/srt.js';
