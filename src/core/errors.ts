import type { StageId } from './types.js';

/** Process exit codes (SPEC §6). */
export const EXIT = {
  OK: 0,
  STAGE_ERROR: 1,
  CONFIG_ERROR: 2,
  MISSING_DEPENDENCY: 3,
  /** Остановлено пользователем (как у оболочки после Ctrl+C). */
  CANCELLED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export abstract class DubPipeError extends Error {
  abstract readonly exitCode: ExitCode;
  /** Extra lines printed after the message, e.g. install instructions. */
  readonly hints: string[];

  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = new.target.name;
    this.hints = hints;
  }
}

/** A stage failed. Carries the stage id and, when known, the offending artifact (SPEC §7). */
export class StageError extends DubPipeError {
  readonly exitCode = EXIT.STAGE_ERROR;
  readonly stage: StageId;
  readonly artifact: string | undefined;

  constructor(stage: StageId, message: string, opts: { artifact?: string; hints?: string[]; cause?: unknown } = {}) {
    // Composed here rather than in a getter: `super(message)` installs `message`
    // as an own property, which would shadow any accessor on the prototype.
    const artifact = opts.artifact ? ` (артефакт: ${opts.artifact})` : '';
    super(`[${stage}] ${message}${artifact}`, opts.hints);
    this.stage = stage;
    this.artifact = opts.artifact;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** Config file is absent, unparseable or fails validation (SPEC §5.3). */
export class ConfigError extends DubPipeError {
  readonly exitCode = EXIT.CONFIG_ERROR;
}

/** A required external binary is missing (SPEC §8). */
export class MissingDependencyError extends DubPipeError {
  readonly exitCode = EXIT.MISSING_DEPENDENCY;
  readonly tool: string;

  constructor(tool: string, message: string, hints: string[] = []) {
    super(message, hints);
    this.tool = tool;
  }
}

export function toExitCode(error: unknown): ExitCode {
  return error instanceof DubPipeError ? error.exitCode : EXIT.STAGE_ERROR;
}
