/**
 * The model-facing win_bash tool.
 *
 * Named win_bash and not bash on purpose: the host already mounts its own
 * bash-family tools (bash, pwsh), and a name collision would either be a
 * duplicate-registration failure or, worse, silently replace the host's tool.
 * This tool is additional capability, not a replacement.
 *
 * Permission resolution follows the host's enforcing families: the effective
 * sandbox policy comes from the sandbox-policy service for the calling
 * session, and a confined session's shell is spawned through the sandbox
 * provider's confine step so the payload never runs outside the boundary the
 * user selected. A composition that reports a confined mode without a usable
 * confinement provider is refused rather than quietly run unconfined.
 * @module @linxin666/dsh-win-bash/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JobRegistryLike } from './background.ts'
import { BACKGROUND_STDERR_BYTES, BACKGROUND_STDOUT_BYTES, startBackgroundJob } from './background.ts'
import type { WinBashConfig } from './config.ts'
import { shellArgv, shellEnvironment, shellTempDir, type ShellRegistry, type ShellResult } from './shell.ts'

/** The registered tool name. Deliberately not bash. */
export const WIN_BASH_TOOL = 'win_bash'

/** Every sandbox mode a session may run under. */
const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** The policy read this tool consumes from the sandbox-policy service. */
interface PolicyResolver {
  resolve(request?: { session?: unknown, mode?: SandboxMode }): SandboxExecutionPolicy
}

/** One runner-failure rule, structurally mirroring the sandbox seam's shape. */
interface RunnerFailureRuleLike {
  allowedExitCodes?: readonly number[]
  fatalSignatures: readonly string[]
  informationalLines?: readonly string[]
}

/** The confinement result this tool consumes, structurally. */
interface ConfinedArgvLike {
  argv: string[]
  enforcement: 'full' | 'partial'
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRuleLike[]
}

/** The confine read this tool consumes from the sandbox service. */
interface ConfinerLike {
  confine(argv: readonly string[], policy: SandboxExecutionPolicy, signal?: AbortSignal): Promise<ConfinedArgvLike>
}

/**
 * Resolve the argv a shell for this call must be spawned with.
 *
 * A restricted session's command may only run inside the boundary the user
 * selected, so the payload's argv goes through the provider's confine step and
 * the CONFINED argv is what gets spawned — for the foreground shell and for a
 * background job alike. A composition that reports a confined mode with no
 * usable provider is refused by the caller rather than run unconfined, so this
 * function is only ever reached with a provider present.
 * @param confiner - the session's sandbox provider, absent under danger-full-access.
 * @param policy - the effective policy.
 * @param argv - the unconfined argv about to be spawned.
 * @param signal - the call's cancellation.
 * @returns the argv to spawn and the confinement it was wrapped with.
 * @throws when the provider's answer is unusable.
 */
async function confineArgv(
  confiner: ConfinerLike | undefined,
  policy: SandboxExecutionPolicy,
  argv: readonly string[],
  signal: AbortSignal | undefined,
): Promise<{ argv: readonly string[], confinement: ConfinedArgvLike | undefined }> {
  if (policy.mode === 'danger-full-access') return { argv, confinement: undefined }
  if (confiner === undefined || typeof confiner.confine !== 'function') {
    throw new Error(
      'SANDBOX_UNAVAILABLE: the session runs under a confined mode and the deployment serves no confinement provider, '
      + 'so win_bash will not start an unconfined shell. Ask the user to switch this session to danger-full-access, or load the sandbox provider.',
    )
  }
  const confinement = await confiner.confine(argv, policy, signal)
  if (!['full', 'partial'].includes(confinement.enforcement) || confinement.argv.length === 0) {
    throw new Error('SANDBOX_UNAVAILABLE: the confinement provider returned an unusable result, so no shell was started.')
  }
  return { argv: confinement.argv, confinement }
}

/** One agent session's working directory, read structurally. */
function sessionCwd(agent: unknown): string | undefined {
  const session = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Single-quote one value for the shell, escaping embedded single quotes.
 * @param value - the raw value.
 * @returns a POSIX single-quoted literal.
 */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
}

/**
 * Normalize a Windows path into the spelling MSYS accepts without escaping:
 * a backslash is also the shell's escape character, so a path handed to cd is
 * converted to forward slashes before it is quoted.
 * @param path - the caller-supplied working directory.
 * @returns the same path with backslashes replaced.
 */
export function normalizeWorkdir(path: string): string {
  return path.split('\\').join('/')
}

/**
 * Clamp a per-call deadline to the configured ceiling.
 * @param requested - the model's timeoutMs, if any.
 * @param configured - the plugin's configured default and ceiling.
 * @returns the effective deadline in milliseconds.
 * @throws when the requested value is not a positive whole number.
 */
export function clampTimeout(requested: number | undefined, configured: number): number {
  if (requested === undefined) return configured
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error('win_bash: timeoutMs must be a positive whole number of milliseconds.')
  }
  return Math.min(requested, configured)
}

/** How one settled run classifies against its confinement. */
interface SandboxFacts {
  mode: SandboxMode
  denied: boolean
  enforcement?: 'full' | 'partial'
  runnerFailed?: boolean
}

/**
 * Classify a settled run against the confinement it ran under.
 *
 * Runner failure and policy denial are different facts (the seam keeps them
 * apart for exactly this reason): a runner that failed proves the command
 * never ran, while a denial proves confinement worked and blocked it. Neither
 * may be reported as an ordinary non-zero exit.
 * @param result - the settled shell result.
 * @param policy - the policy the run was resolved under.
 * @param confinement - the confine result, when one was used.
 * @returns the sandbox facts recorded on the tool output.
 */
export function classifySandbox(
  result: ShellResult,
  policy: SandboxExecutionPolicy,
  confinement: ConfinedArgvLike | undefined,
): SandboxFacts {
  if (policy.mode === 'danger-full-access' || confinement === undefined) {
    return { mode: policy.mode, denied: false }
  }
  const text = (result.stderr + '\n' + result.stdout).toLowerCase()
  const runnerFailed = result.exitCode !== 0 && confinement.runnerFailureRules.some(rule => {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(result.exitCode)) return false
    const lines = result.stderr.split(/\r?\n/)
      .filter(line => !(rule.informationalLines ?? []).includes(line))
    return lines.some(line => rule.fatalSignatures.some(sig => line.toLowerCase().includes(sig.toLowerCase())))
  })
  const denied = !runnerFailed && result.exitCode !== 0
    && confinement.denialSignatures.some(sig => text.includes(sig.toLowerCase()))
  return {
    mode: policy.mode,
    denied,
    enforcement: confinement.enforcement,
    ...(runnerFailed ? { runnerFailed: true } : {}),
  }
}

/** The truncation facts a rendered result reports to the model. */
export interface RenderFacts {
  /** Visible stdout, already cut to its byte budget. */
  stdout: string
  /** Visible stderr, already cut to its byte budget. */
  stderr: string
  /** The command's exit status. */
  exitCode: number
  /** Sandbox classification for the call. */
  sandbox?: { mode: string, denied: boolean, runnerFailed?: boolean }
  /** True when visible stdout hit its byte budget. */
  stdoutTruncated?: boolean
  /** True when visible stderr hit its byte budget. */
  stderrTruncated?: boolean
  /** True when the retained stdout lost its head. */
  stdoutLostHead?: boolean
  /** True when the retained stderr lost its head. */
  stderrLostHead?: boolean
  /** True when the frame watch window dropped the middle of stdout. */
  frameOverflow?: boolean
  /** Host path of the complete stdout, when the provider spilled it. */
  stdoutSpillPath?: string
  /** Host path of the complete stderr, when the provider spilled it. */
  stderrSpillPath?: string
}

/** UTF-8 byte length of a string. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The line that tells the model its view of one stream is incomplete.
 *
 * WHY THIS IS NOT DECORATION. The visible text is the TAIL of the stream: the
 * head was already cut to fit the byte budget, so the first thing the model
 * reads can be the middle of a line with nothing marking the cut. Without this
 * line a partial result is indistinguishable from a short one, and a model
 * reading a truncated listing draws conclusions from data it never saw.
 * @param stream - stream label.
 * @param visible - the bytes actually shown.
 * @param flags - which cuts happened.
 * @param spillPath - complete-stream file, when the provider kept one.
 * @returns the notice, or undefined when that stream was shown in full.
 */
export function truncationNotice(
  stream: 'stdout' | 'stderr',
  visible: string,
  flags: { truncated: boolean, lostHead: boolean, overflow: boolean },
  spillPath?: string,
): string | undefined {
  if (!flags.truncated && !flags.lostHead && !flags.overflow) return undefined
  const parts = [
    '[win_bash: ' + stream + ' was truncated, only the last ' + byteLength(visible).toString() + ' bytes are shown',
  ]
  if (flags.lostHead || flags.truncated) parts.push('; the beginning was dropped')
  if (flags.overflow) parts.push('; a middle window was dropped by the frame watch limit')
  if (spillPath !== undefined) parts.push('. The complete stream is at ' + spillPath)
  parts.push(']')
  return parts.join('')
}

/** Render one result the way the host's own shell tools render theirs. */
export function renderResult(value: RenderFacts): string {
  let body = value.stdout
  if (value.stderr !== '') {
    if (body !== '' && !body.endsWith('\n')) body += '\n'
    body += '[stderr]\n' + value.stderr
  }
  if (body === '') body = '(no output)'
  const parts = [body]
  // The truncation notices come FIRST, before the sandbox and exit lines: a
  // model that reads only the head of a long result still learns that the
  // output was cut, which is the one fact it cannot recover from the text.
  const outNotice = truncationNotice('stdout', value.stdout, {
    truncated: value.stdoutTruncated === true,
    lostHead: value.stdoutLostHead === true,
    overflow: value.frameOverflow === true,
  }, value.stdoutSpillPath)
  if (outNotice !== undefined) parts.push(outNotice)
  const errNotice = truncationNotice('stderr', value.stderr, {
    truncated: value.stderrTruncated === true,
    lostHead: value.stderrLostHead === true,
    overflow: false,
  }, value.stderrSpillPath)
  if (errNotice !== undefined) parts.push(errNotice)
  if (value.sandbox?.runnerFailed === true) {
    parts.push('[sandbox: the confinement runner failed under ' + value.sandbox.mode + ' mode, so the command did not run]')
  } else if (value.sandbox?.denied === true) {
    parts.push('[sandbox: the command was denied a file effect under ' + value.sandbox.mode + ' mode]')
  }
  if (value.exitCode !== 0) parts.push('[exit code: ' + value.exitCode.toString() + ']')
  return parts.join('\n')
}

/**
 * The deployment's background job registry, read without letting a refused
 * lookup escape: a cordis service proxy throws for a name it cannot resolve,
 * and "this deployment composes no job registry" is an ordinary state here,
 * not an error.
 * @param ctx - the plugin context.
 * @returns the registry, or undefined when this deployment has none.
 */
export function readJobRegistry(ctx: Context): JobRegistryLike | undefined {
  let candidate: unknown
  try {
    candidate = ctx.get('jobs')
  } catch {
    return undefined
  }
  if (candidate === null || typeof candidate !== 'object') return undefined
  if (typeof (candidate as { start?: unknown }).start !== 'function') return undefined
  return candidate as JobRegistryLike
}

/** The session's effective policy, or undefined when the service is absent. */
function resolvePolicy(ctx: Context): SandboxExecutionPolicy | undefined {
  const service = ctx.get('sandboxPolicy') as PolicyResolver | undefined
  if (service === undefined || typeof service.resolve !== 'function') return undefined
  const policy = service.resolve({ session: undefined })
  if (!SANDBOX_MODES.includes(policy.mode) || typeof policy.workspaceRoot !== 'string') {
    throw new Error('win_bash: the sandbox policy service returned an invalid policy; no command was started.')
  }
  return policy
}

/**
 * Build the win_bash tool bound to one payload and one shell registry.
 * @param ctx - host context carrying the optional sandbox services.
 * @param config - the resolved plugin configuration.
 * @param runtime - absolute shell and payload paths.
 * @param shells - the registry owning this plugin instance's shells.
 * @returns the tool definition, ready for the tools registry.
 */
export function buildWinBashTool(
  ctx: Context,
  config: WinBashConfig,
  runtime: { bash: string, bin: string },
  shells: ShellRegistry,
): ToolDefinition {
  // The background surface follows the registry, read once at build time: the
  // entry registers the foreground-only variant when this deployment composes
  // no job registry, so run_in_background is not advertised where it could
  // never be honoured.
  const jobs = config.enableRunInBackground ? readJobRegistry(ctx) : undefined
  return defineTool({
    name: WIN_BASH_TOOL,
    description: config.description,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description:
          "The bash command to run in this session's persistent shell. Any number of lines; the working directory and exported variables from earlier win_bash calls are still in effect.",
      },
      workdir: {
        type: 'string',
        description:
          "Working directory for this command. Omitted keeps the shell's current directory, which is the session workspace until a command cds elsewhere. A relative path resolves against that directory.",
      },
      timeoutMs: {
        type: 'integer',
        description:
          'Wall-clock limit for this command in milliseconds (default '
          + config.timeoutMs.toString()
          + '). On expiry the shell is stopped and the next call starts a fresh one.',
      },
      ...jobs === undefined ? {} : {
        run_in_background: {
          type: 'boolean' as const,
          description:
            'Run in a separate pinned bash process and return a job id immediately; collect it with job_output and stop it with job_kill. '
            + 'No timeout applies, the persistent shell is not used, and this process survives this call.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
          // The truncation facts ./shell.ts already computes. They are declared
          // here because an undeclared output member is not part of the
          // canonical value the model's rendering is projected from.
          stdoutTruncated: { type: 'boolean' },
          stderrTruncated: { type: 'boolean' },
          stdoutLostHead: { type: 'boolean' },
          stderrLostHead: { type: 'boolean' },
          frameOverflow: { type: 'boolean' },
          stdoutSpillPath: { type: 'string' },
          stderrSpillPath: { type: 'string' },
          jobId: { type: 'string' },
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true },
              denied: { type: 'boolean', required: true },
              enforcement: { type: 'string' },
              runnerFailed: { type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: value.jobId === undefined
          ? renderResult(value)
          : 'started background job ' + value.jobId
            + ' (collect it with job_output, stop it with job_kill)',
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('win_bash needs an owning agent session: the persistent shell belongs to the session that calls it.')
      }
      const cwd = sessionCwd(agent)
      if (cwd === undefined) {
        throw new Error('win_bash needs a calling session with a working directory.')
      }
      const policy = resolvePolicy(ctx)
      if (policy === undefined) {
        throw new Error(
          'win_bash: the deployment serves no sandbox policy service, so this command has no authoritative permission mode and will not run.',
        )
      }
      const timeoutMs = clampTimeout(args.timeoutMs, config.timeoutMs)
      const command = args.workdir === undefined || args.workdir === ''
        ? args.command
        : 'cd ' + shellQuote(normalizeWorkdir(args.workdir)) + ' && ' + args.command
      const confiner = ctx.get('sandbox') as ConfinerLike | undefined

      // A background job owns its own pinned process. It must be refused
      // BEFORE any decision to run it in the foreground: silently running the
      // command in this session's persistent shell would hang the caller for
      // the command's whole lifetime and then die with that shell, which is
      // the opposite of what was asked for.
      if (args.run_in_background === true) {
        if (!config.enableRunInBackground) {
          throw new Error(
            'win_bash: run_in_background is disabled for this deployment (enableRunInBackground: false),'
            + ' so this call was not started.',
          )
        }
        const registry = readJobRegistry(ctx)
        if (registry === undefined) {
          throw new Error(
            'BACKGROUND_UNAVAILABLE: this deployment composes no background job registry (ctx.jobs), so win_bash cannot'
            + ' register a background command. This call was not run in the foreground instead. Ask the user to load'
            + ' @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs, or run this command without run_in_background.',
          )
        }
        const confined = await confineArgv(confiner, policy, shellArgv(runtime), exec.signal)
        const jobId = startBackgroundJob({
          subprocess: ctx.subprocess,
          jobs: registry,
          owner: agent.id,
          script: command,
          argv: confined.argv,
          cwd,
          env: shellEnvironment(runtime, shellTempDir()),
          label: args.command,
          stdoutBytes: BACKGROUND_STDOUT_BYTES,
          stderrBytes: BACKGROUND_STDERR_BYTES,
        })
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          jobId,
          sandbox: { mode: policy.mode, denied: false },
        }
      }

      const confined = await confineArgv(confiner, policy, shellArgv(runtime), exec.signal)

      const result = await shells.run(agent, runtime, cwd, command, {
        stdoutBytes: config.maxStdoutBytes,
        stderrBytes: config.maxStderrBytes,
        timeoutMs,
        signal: exec.signal,
      }, { argv: confined.argv })
      const sandbox = classifySandbox(result, policy, confined.confinement)
      if (sandbox.runnerFailed === true) {
        throw new Error(
          'EXECUTOR_UNAVAILABLE: the DSH confinement runner failed under ' + policy.mode
          + ' mode, so the command did not run. This is a sandbox problem, neither a user denial nor a command failure; '
          + 'do not retry the same command and do not attempt to bypass confinement.',
        )
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        stdoutLostHead: result.stdoutLostHead,
        stderrLostHead: result.stderrLostHead,
        frameOverflow: result.frameOverflow,
        ...(result.stdoutSpillPath === undefined ? {} : { stdoutSpillPath: result.stdoutSpillPath }),
        ...(result.stderrSpillPath === undefined ? {} : { stderrSpillPath: result.stderrSpillPath }),
        sandbox: { mode: sandbox.mode, denied: sandbox.denied, ...(sandbox.enforcement === undefined ? {} : { enforcement: sandbox.enforcement }) },
      }
    },
    presentCall: (args) => args.run_in_background === true
      ? {
          card: 'generic' as const,
          title: args.command,
          kind: 'execute' as const,
          rawInput: args.command,
          content: [{ type: 'text' as const, text: 'background command (win_bash)' }],
        }
      : {
          card: 'terminal' as const,
          title: args.command,
          description: 'persistent bash (win_bash)',
        },
  })
}
