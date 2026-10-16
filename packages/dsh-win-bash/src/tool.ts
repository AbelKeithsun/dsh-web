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
import type { WinBashConfig } from './config.ts'
import type { ShellRegistry, ShellResult } from './shell.ts'

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

/** Render one result the way the host's own shell tools render theirs. */
export function renderResult(value: {
  stdout: string
  stderr: string
  exitCode: number
  sandbox?: { mode: string, denied: boolean, runnerFailed?: boolean }
}): string {
  let body = value.stdout
  if (value.stderr !== '') {
    if (body !== '' && !body.endsWith('\n')) body += '\n'
    body += '[stderr]\n' + value.stderr
  }
  if (body === '') body = '(no output)'
  const parts = [body]
  if (value.sandbox?.runnerFailed === true) {
    parts.push('[sandbox: the confinement runner failed under ' + value.sandbox.mode + ' mode, so the command did not run]')
  } else if (value.sandbox?.denied === true) {
    parts.push('[sandbox: the command was denied a file effect under ' + value.sandbox.mode + ' mode]')
  }
  if (value.exitCode !== 0) parts.push('[exit code: ' + value.exitCode.toString() + ']')
  return parts.join('\n')
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
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
      render: (_args, value) => [{ type: 'text' as const, text: renderResult(value) }],
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

      let confinement: ConfinedArgvLike | undefined
      if (policy.mode !== 'danger-full-access') {
        const confiner = ctx.get('sandbox') as ConfinerLike | undefined
        if (confiner === undefined || typeof confiner.confine !== 'function') {
          throw new Error(
            'SANDBOX_UNAVAILABLE: the session runs under a confined mode and the deployment serves no confinement provider, '
            + 'so win_bash will not start an unconfined shell. Ask the user to switch this session to danger-full-access, or load the sandbox provider.',
          )
        }
        confinement = await confiner.confine(
          [runtime.bash, '--norc', '--noprofile', '-s'],
          policy,
          exec.signal,
        )
        if (!['full', 'partial'].includes(confinement.enforcement) || confinement.argv.length === 0) {
          throw new Error('SANDBOX_UNAVAILABLE: the confinement provider returned an unusable result, so no shell was started.')
        }
      }

      const result = await shells.run(agent, runtime, cwd, command, {
        stdoutBytes: config.maxStdoutBytes,
        stderrBytes: config.maxStderrBytes,
        timeoutMs,
        signal: exec.signal,
      })
      const sandbox = classifySandbox(result, policy, confinement)
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
        sandbox: { mode: sandbox.mode, denied: sandbox.denied, ...(sandbox.enforcement === undefined ? {} : { enforcement: sandbox.enforcement }) },
      }
    },
    presentCall: (args) => ({
      card: 'terminal' as const,
      title: args.command,
      description: 'persistent bash (win_bash)',
    }),
  })
}
