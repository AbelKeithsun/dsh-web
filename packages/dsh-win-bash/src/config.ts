/**
 * Plugin configuration: the win_bash tool's budgets and description.
 *
 * Every field is optional in the profile patch and defaulted here, so a row
 * with no config block still mounts a working tool. The schema is also the
 * settings page: the Host renders one form per profile entry from this same
 * Config, which is why the defaults are stated in the field comments as well
 * as in the schema.
 * @module @linxin666/dsh-win-bash/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_STDERR_BYTES, DEFAULT_MAX_STDOUT_BYTES } from './shell.ts'

/** Whole-call deadline floor, in milliseconds. */
export const TIMEOUT_MIN_MS = 1000

/** Whole-call deadline ceiling, in milliseconds. */
export const TIMEOUT_MAX_MS = 3_600_000

/** Default whole-call deadline, matching the host's own persistent shell. */
export const DEFAULT_TIMEOUT_MS = 300_000

/** Visible stdout budget floor, in bytes. */
export const STDOUT_MIN_BYTES = 1024

/** Visible stdout budget ceiling, in bytes. */
export const STDOUT_MAX_BYTES = 1024 * 1024

/** Visible stderr budget floor, in bytes. */
export const STDERR_MIN_BYTES = 1024

/** Visible stderr budget ceiling, in bytes. */
export const STDERR_MAX_BYTES = 512 * 1024

/**
 * Model-facing tool description. Active voice; states the persistence
 * guarantee and the two facts a model must know before choosing this tool
 * over the host's own shell: this is a real MSYS2 bash, and its state belongs
 * to this session.
 */
export const DEFAULT_DESCRIPTION = [
  "Run a command in this session's persistent bash shell, a pinned MSYS2 bash shipped with the plugin.",
  'The working directory, exported variables, functions and shell history persist across win_bash calls in this session;',
  'each call is a foreground command with bounded stdout and stderr and a real exit code.',
  'Use this instead of the host shell when the command is bash or Unix syntax (pipes, $VAR, globs, single quotes, here-documents).',
].join(' ')

/** Config shape a profile row may supply; every field is optional. */
export interface WinBashConfigInput {
  /** Whole-call deadline in milliseconds. */
  timeoutMs?: number
  /** Visible stdout byte budget. */
  maxStdoutBytes?: number
  /** Visible stderr byte budget. */
  maxStderrBytes?: number
  /** Model-facing tool description override. */
  description?: string
}

/** Config shape the plugin runs with; every field resolved. */
export interface WinBashConfig {
  /** Whole-call deadline in milliseconds. */
  timeoutMs: number
  /** Visible stdout byte budget. */
  maxStdoutBytes: number
  /** Visible stderr byte budget. */
  maxStderrBytes: number
  /** Model-facing tool description. */
  description: string
}

/** Runtime configuration schema for the win_bash tool. */
export const Config: z<WinBashConfigInput, WinBashConfig> = z.object({
  timeoutMs: z.number().min(TIMEOUT_MIN_MS).max(TIMEOUT_MAX_MS).default(DEFAULT_TIMEOUT_MS),
  maxStdoutBytes: z.number().min(STDOUT_MIN_BYTES).max(STDOUT_MAX_BYTES).default(DEFAULT_MAX_STDOUT_BYTES),
  maxStderrBytes: z.number().min(STDERR_MIN_BYTES).max(STDERR_MAX_BYTES).default(DEFAULT_MAX_STDERR_BYTES),
  description: z.string().default(DEFAULT_DESCRIPTION),
})

/** The values an omitted field takes. */
export const CONFIG_DEFAULTS: WinBashConfig = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
  maxStderrBytes: DEFAULT_MAX_STDERR_BYTES,
  description: DEFAULT_DESCRIPTION,
}

/** One rejected configuration field. */
export interface ConfigViolation {
  /** Field name. */
  readonly field: string
  /** Why the value cannot be used. */
  readonly message: string
}

/**
 * Resolve a raw config object into the running configuration.
 *
 * The Host validates the row through {@link Config} before apply runs, so this
 * is the second gate: it exists because tests and hand-built contexts call the
 * plugin's apply directly, and because a bounded integer is a contract the
 * shell's budgets depend on (a NaN budget would make every output look
 * truncated).
 * @param input - the raw config, or undefined.
 * @returns the resolved configuration.
 * @throws when a supplied value is outside its contract.
 */
export function resolveConfig(input: WinBashConfigInput | undefined): WinBashConfig {
  const resolved: WinBashConfig = { ...CONFIG_DEFAULTS, ...(input ?? {}) }
  const violations = validateConfig(resolved)
  if (violations.length > 0) {
    throw new Error(
      'win_bash config rejected: '
      + violations.map(v => v.field + ': ' + v.message).join('; '),
    )
  }
  return resolved
}

/**
 * Check every field of a resolved configuration.
 * @param config - the candidate configuration.
 * @returns one entry per rejected field; empty means accepted.
 */
export function validateConfig(config: WinBashConfig): ConfigViolation[] {
  const violations: ConfigViolation[] = []
  const bounded = (field: 'timeoutMs' | 'maxStdoutBytes' | 'maxStderrBytes', min: number, max: number): void => {
    const value = config[field]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      violations.push({ field, message: 'must be an integer between ' + min.toString() + ' and ' + max.toString() })
    }
  }
  bounded('timeoutMs', TIMEOUT_MIN_MS, TIMEOUT_MAX_MS)
  bounded('maxStdoutBytes', STDOUT_MIN_BYTES, STDOUT_MAX_BYTES)
  bounded('maxStderrBytes', STDERR_MIN_BYTES, STDERR_MAX_BYTES)
  if (typeof config.description !== 'string' || config.description.trim() === '') {
    violations.push({ field: 'description', message: 'must be a non-empty string' })
  }
  return violations
}
