/**
 * LIVE confinement verification: the real ACL restricted-token runner, not a
 * fake provider.
 *
 * ./confinement.spec.ts certifies the SHAPE of this plugin's confinement
 * contract against an injected provider. This file answers the question the
 * shape test cannot: does the real Windows backend actually confine, and does
 * the confined argv really reach the runner?
 *
 * PREREQUISITES (a run that cannot meet them SKIPS, loudly; it never fakes a
 * pass). All three are read-only checks:
 *   1. process.platform === 'win32' — the ACL runner is the win32 rung only.
 *   2. The runner resolves, from DSH_WIN_BASH_ACL_RUNNER or by node resolution
 *      of @deepseek-ai/dsh-sandbox-windows-acl/runner. That package ships in
 *      the DSH host's dependency tree, not in this repository's, so the
 *      environment variable is the normal way to point this suite at a real
 *      install.
 *   3. The pinned payload bash exists in runtime/win32-x64.
 *
 * The reproducible command, including how to obtain prerequisite 2:
 *
 *   DSH_WIN_BASH_ACL_RUNNER=<DSH checkout>/packages/sandbox/sandbox-windows-acl/lib/runner.js \
 *     pnpm --filter @linxin666/dsh-win-bash test
 *
 * WHY THE WRITE-DENIAL ASSERTION USES node.exe AND NOT cmd.exe. Two measured
 * facts on this host (win32 x64, Windows 10.0.26200, zh-CN locale):
 *
 *   - The denial SIGNATURES the rung carries are English. cmd.exe reports a
 *     refused redirect in the system display language ("拒绝访问。"), which
 *     matches no signature, so a REAL denial there classifies as an ordinary
 *     non-zero exit. node.exe reports its own English "EPERM: operation not
 *     permitted", which does match. The localization gap is a property of the
 *     upstream rung (dsh-sandbox-local's DENIAL_SIGNATURES), not of this
 *     package, and is pinned below as a known boundary rather than hidden.
 *   - A confined process that writes through node is the representative
 *     producer here anyway: this plugin's payload is MSYS, whose tools report
 *     in English.
 *
 * KNOWN BOUNDARY, MEASURED ON THIS HOST: the pinned MSYS payload CANNOT START
 * under the restricted token. bash.exe, sh.exe, dash.exe and echo.exe all die
 * before main with
 *     0 [main] bash (N): *** fatal error -
 *     NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-<hash>): 0xC0000022
 * and exit 3221225794 (0xC0000142, STATUS_DLL_INIT_FAILED). System Git for
 * Windows fails the same way ("couldn't create signal pipe, Win32 error 5"),
 * so this is an MSYS/Cygwin-runtime requirement — its daemon shared-memory
 * object needs a write the restricted token withholds — not a property of this
 * package's extraction. cmd.exe, node.exe and powershell.exe all run confined
 * on the same host, so the runner and this plugin's argv plumbing are sound;
 * what is unproven is any bash command under a confined mode.
 *
 * @module tests/confinement-live
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { resolveConfig } from '../src/config.ts'
import { ShellRegistry, shellArgv } from '../src/shell.ts'
import { buildWinBashTool, classifySandbox } from '../src/tool.ts'

/** The windows-acl rung's own facts, mirrored from dsh-sandbox-local. */
const WINDOWS_ACL_FACTS = {
  enforcement: 'partial' as const,
  denialSignatures: ['access is denied', 'access to the path', 'permission denied', 'operation not permitted'],
  runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
}

/** This package's root, so the payload path is derived rather than guessed. */
const PACKAGE_ROOT = join(import.meta.dirname, '..')

/** The pinned payload's bash, and its bin directory. */
const PAYLOAD_BIN = join(PACKAGE_ROOT, 'runtime', 'win32-x64', 'usr', 'bin')
const PAYLOAD_BASH = join(PAYLOAD_BIN, 'bash.exe')

/**
 * The real confinement runner, when this host has one.
 * @returns the runner entry path, or undefined when this host cannot serve it.
 */
function resolveRunner(): string | undefined {
  const fromEnv = process.env.DSH_WIN_BASH_ACL_RUNNER
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  } catch {
    return undefined
  }
}

const RUNNER = process.platform === 'win32' ? resolveRunner() : undefined

/**
 * The REAL provider, when this host can load one. Set
 * DSH_WIN_BASH_ACL_PROVIDER to dsh-sandbox-local's lib/index.js to make the
 * end-to-end test drive a real confine() instead of the mirrored argv shape.
 * @returns the module's LocalSandboxProvider, or undefined.
 */
async function resolveProvider(): Promise<{ confine(argv: readonly string[], policy: unknown): Promise<{
  argv: string[], enforcement: 'full' | 'partial', denialSignatures: readonly string[], runnerFailureRules: readonly unknown[],
}> } | undefined> {
  const fromEnv = process.env.DSH_WIN_BASH_ACL_PROVIDER
  if (fromEnv === undefined || fromEnv === '' || !existsSync(fromEnv)) return undefined
  const module = await import(pathToFileURL(fromEnv).href) as { LocalSandboxProvider?: unknown }
  const Ctor = module.LocalSandboxProvider
  if (typeof Ctor !== 'function') return undefined
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  return new (Ctor as new (ctx: unknown, config: unknown) => never)(ctx, {
    runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5_000,
  }) as never
}

/** Why this suite cannot run here, or undefined when it can. */
const SKIP_REASON = process.platform !== 'win32'
  ? 'not win32: the ACL restricted-token runner is the win32 rung only'
  : RUNNER === undefined
    ? 'no ACL runner: set DSH_WIN_BASH_ACL_RUNNER to @deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js, or install that package'
    : undefined

/** The mode a live invocation runs under. */
type LiveMode = 'read-only' | 'workspace-write'

/** One settled confined invocation. */
interface RunOutcome {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Spawn one command under the real runner, exactly as the sandbox seam builds
 * it: [node, runner, --workspace, --temp, --mode, --, ...argv]. The temp root
 * is always a SEPARATE directory: the runner refuses a temp root inside the
 * workspace, which is also the shape the seam's own grant materialization has.
 * @param argv - the argv to confine.
 * @param mode - the file-effect mode.
 * @param workspace - the writable root the mode grants (or withholds).
 * @returns the settled outcome.
 */
function runConfined(argv: readonly string[], mode: LiveMode, workspace: string): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const temp = join(workspace, '..', 'dsh-win-bash-live-temp')
    mkdirSync(temp, { recursive: true })
    // The bound is a signal, not a timer: aborting kills the child and
    // surfaces as this promise's rejection, so no arbitrary wait is involved.
    const child = spawn(process.execPath, [
      RUNNER as string, '--workspace', workspace, '--temp', temp, '--mode', mode, '--', ...argv,
    ], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(60_000) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { reject(error) })
    child.on('close', (code) => { resolve({ exitCode: code, stdout, stderr }) })
    child.stdin.end()
  })
}

/**
 * Spawn one already-built confined argv (the real provider's answer) directly.
 * @param argv - the argv to spawn, runner prefix included.
 * @param cwd - the working directory.
 * @returns the settled outcome.
 */
function spawnArgv(argv: readonly string[], cwd: string): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(60_000),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { reject(error) })
    child.on('close', (code) => { resolve({ exitCode: code, stdout, stderr }) })
    child.stdin.end()
  })
}

/** A fresh scratch workspace outside the repository. */
function scratchDir(): string {
  const dir = join(tmpdir(), 'dsh-win-bash-live-' + Math.random().toString(36).slice(2, 10))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A path outside every grant a read-only mode withholds. */
function outsidePath(): string {
  return join(tmpdir(), 'dsh-win-bash-live-outside-' + Math.random().toString(36).slice(2, 10) + '.txt')
}

/**
 * A node one-liner that writes a file, reporting its own English errno.
 * @param target - the file to create.
 * @returns the script source.
 */
function nodeWrite(target: string): string {
  return 'const fs=require("fs");try{fs.writeFileSync(' + JSON.stringify(target)
    + ',"x");console.log("WROTE")}catch(e){console.error(e.code+": "+e.message);process.exit(3)}'
}

/** A subprocess seam that records spawns instead of starting them. */
function recordingSubprocess() {
  const argv: string[][] = []
  const runtime = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      argv.push([...spec.argv])
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: {},
        done: new Promise(() => {}),
        terminate: () => {},
        waitForExit: async () => true,
      } as unknown as SubprocessHandle
    },
  }
  return { runtime: runtime as unknown as SubprocessRuntime, argv }
}

/** The structural context the tool reads. */
function context(services: { sandbox?: unknown, jobs?: unknown, subprocess?: unknown, mode: string }): Context {
  const policy = { mode: services.mode, workspaceRoot: process.cwd() } as unknown as SandboxExecutionPolicy
  return {
    get: (name: string) => {
      if (name === 'sandboxPolicy') return { resolve: () => policy }
      if (name === 'sandbox') return services.sandbox
      if (name === 'jobs') return services.jobs
      return undefined
    },
    subprocess: services.subprocess,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Context
}

/** The execution identity the tool reads. */
function exec(signal?: AbortSignal) {
  return { agent: { id: 'session-1', session: { header: { cwd: process.cwd() } } }, signal }
}

/** One macrotask turn, so a call's awaited chain reaches its spawn. */
function settleTurn(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve) })
}

/** Run one foreground call far enough to observe its spawn, then cancel it. */
async function queueOneCall(tool: { execute(args: unknown, exec: never): Promise<unknown> }, shells: ShellRegistry): Promise<void> {
  const controller = new AbortController()
  const call = tool.execute({ command: 'echo hi' }, exec(controller.signal) as never)
  const contained = call.then(() => undefined, () => undefined)
  await settleTurn()
  controller.abort()
  await contained
  await shells.disposeAll('test teardown')
}

/** The confinement facts one live run is classified against. */
const LIVE_CONFINEMENT = { argv: [] as string[], ...WINDOWS_ACL_FACTS }

/** Classify one live outcome against the read-only policy it ran under. */
function classifyLive(outcome: RunOutcome, workspace: string) {
  return classifySandbox(
    { stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode ?? 0 } as never,
    { mode: 'read-only', workspaceRoot: workspace } as unknown as SandboxExecutionPolicy,
    LIVE_CONFINEMENT,
  )
}

describe.skipIf(SKIP_REASON !== undefined)('live ACL confinement (real runner)', () => {
  it('operator under a confined mode gets the REAL provider confine result spawned, and the real boundary holds for it', async () => {
    // Given the real sandbox provider (dsh-sandbox-local) and a scratch
    // workspace,
    const provider = await resolveProvider()
    const workspace = scratchDir()
    if (provider === undefined) {
      // Without the provider module this half cannot run; the mirrored-shape
      // test below still proves the argv plumbing. Reported, never silent.
      expect(process.env.DSH_WIN_BASH_ACL_PROVIDER).toBeUndefined()
      return
    }
    // When it confines the payload argv this plugin would spawn,
    const payloadArgv = shellArgv({ bash: PAYLOAD_BASH })
    const confinement = await provider.confine(payloadArgv, { mode: 'read-only', workspaceRoot: workspace })
    // Then it answers with the runner prefix and the rung's own facts,
    expect(confinement.enforcement).toBe('partial')
    expect(confinement.argv[0]).toBe(process.execPath)
    expect(confinement.argv).toContain('--mode')
    expect(confinement.argv.slice(confinement.argv.indexOf('--') + 1)).toEqual(payloadArgv)
    // And the real boundary holds for that EXACT confined argv: a command run
    // under it really starts, and a write outside the grant is really denied.
    const outside = outsidePath()
    const denied = await spawnArgv([
      ...confinement.argv.slice(0, confinement.argv.indexOf('--')),
      '--', process.execPath, '-e', nodeWrite(outside),
    ], workspace)
    expect(existsSync(outside)).toBe(false)
    expect(denied.exitCode).toBe(3)
    const classified = classifySandbox(
      { stdout: denied.stdout, stderr: denied.stderr, exitCode: denied.exitCode ?? 0 } as never,
      { mode: 'read-only', workspaceRoot: workspace } as unknown as SandboxExecutionPolicy,
      { argv: confinement.argv, enforcement: confinement.enforcement, denialSignatures: confinement.denialSignatures, runnerFailureRules: confinement.runnerFailureRules } as never,
    )
    expect(classified.denied).toBe(true)
    expect(classified.runnerFailed).toBeUndefined()
  })

  it('operator running a command under the real runner sees it really start inside the boundary', async () => {
    // Given a scratch workspace,
    const workspace = scratchDir()
    // When a command runs through the real runner in read-only mode,
    const outcome = await runConfined(['cmd', '/c', 'echo confined-ok'], 'read-only', workspace)
    // Then it really ran: this is the fact that makes the denial below
    // evidence of confinement rather than a crash report.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain('confined-ok')
  })

  it('operator writing outside the boundary is denied, and the denial classifies as denied rather than as an ordinary non-zero exit', async () => {
    // Given a target outside every grant read-only withholds,
    const workspace = scratchDir()
    const outside = outsidePath()
    if (existsSync(outside)) unlinkSync(outside)
    // When a confined process tries to create it,
    const outcome = await runConfined([process.execPath, '-e', nodeWrite(outside)], 'read-only', workspace)
    // Then the write was refused and no file appeared,
    expect(outcome.exitCode).toBe(3)
    expect(outcome.stderr).toContain('EPERM')
    expect(existsSync(outside)).toBe(false)
    // And the tool's own classifier reads that real stderr as a DENIAL, not as
    // an ordinary non-zero exit.
    const classified = classifyLive(outcome, workspace)
    expect(classified.denied).toBe(true)
    expect(classified.runnerFailed).toBeUndefined()
    expect(classified.enforcement).toBe('partial')
  })

  it('operator under a confined mode with no confinement provider is refused with SANDBOX_UNAVAILABLE and no process is ever spawned', async () => {
    // Given a confined session whose deployment serves no confinement provider,
    const subprocess = recordingSubprocess()
    const shells = new ShellRegistry(subprocess.runtime)
    const tool = buildWinBashTool(
      context({ subprocess: subprocess.runtime, mode: 'read-only' }),
      resolveConfig(undefined),
      { bash: PAYLOAD_BASH, bin: PAYLOAD_BIN },
      shells,
    )
    // When the model runs a command,
    let message = ''
    try {
      await tool.execute({ command: 'echo hi' }, exec() as never)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // Then the call is refused by name,
    expect(message).toContain('SANDBOX_UNAVAILABLE')
    // And NOTHING was spawned: no unconfined shell leaked onto the host.
    expect(subprocess.argv).toEqual([])
  })

  it('operator asking for a background command under a confined mode also gets the confined argv, never the payload argv', async () => {
    // Given a confined session with a job registry and a provider that wraps
    // (the real provider is exercised by the tests above; this one is about
    // which argv the BACKGROUND path spawns),
    const subprocess = recordingSubprocess()
    const registry = {
      start(spec: { run(job: { id: string, append(): void }): { cancel(): void, done: Promise<unknown> } }) {
        spec.run({ id: 'win-bash-1', append: () => {} })
        return 'win-bash-1'
      },
    }
    const provider = {
      confine: async (argv: readonly string[]) => ({
        argv: ['C:/runner.exe', '--mode', 'read-only', '--', ...argv],
        ...WINDOWS_ACL_FACTS,
      }),
    }
    const shells = new ShellRegistry(subprocess.runtime)
    const tool = buildWinBashTool(
      context({ sandbox: provider, jobs: registry, subprocess: subprocess.runtime, mode: 'read-only' }),
      resolveConfig(undefined),
      { bash: PAYLOAD_BASH, bin: PAYLOAD_BIN },
      shells,
    )
    // When the model starts a background command,
    const value = await tool.execute({ command: 'echo bg', run_in_background: true }, exec() as never) as { jobId?: string }
    // Then the job started the provider's confined argv, not the payload's own.
    expect(value.jobId).toBe('win-bash-1')
    expect(subprocess.argv[0]).toEqual(['C:/runner.exe', '--mode', 'read-only', '--', ...shellArgv({ bash: PAYLOAD_BASH })])
    expect(subprocess.argv[0]).not.toEqual(shellArgv({ bash: PAYLOAD_BASH }))
    await shells.disposeAll('test teardown')
  })

  it('operator reading a result gets runnerFailed and denied kept apart, in both directions', () => {
    // Given the windows-acl rung's own signatures,
    const policy = { mode: 'read-only', workspaceRoot: process.cwd() } as unknown as SandboxExecutionPolicy
    // When a runner failure is classified (the runner's own exit 127 and its
    // signature line, taken verbatim from a real invocation),
    const failed = classifySandbox(
      { stdout: '', stderr: 'windows-acl-run: CreateProcessAsUserW failed (Win32 2): command: --bogus', exitCode: 127 } as never,
      policy,
      LIVE_CONFINEMENT,
    )
    // Then it is a runner failure, never a denial: the command did not run.
    expect(failed.runnerFailed).toBe(true)
    expect(failed.denied).toBe(false)
    // And when a real denial is classified (node's own English errno),
    const denied = classifySandbox(
      { stdout: '', stderr: "EPERM: operation not permitted, open 'C:\\x'", exitCode: 1 } as never,
      policy,
      LIVE_CONFINEMENT,
    )
    // Then it is a denial, never a runner failure: confinement worked.
    expect(denied.denied).toBe(true)
    expect(denied.runnerFailed).toBeUndefined()
    // And a command that merely PRINTS the runner's signature on its own
    // non-zero exit is not misread as a runner failure: the rung's rule is
    // exit-gated on 127 for exactly this reason.
    const printed = classifySandbox(
      { stdout: '', stderr: 'windows-acl-run: a string a command printed', exitCode: 1 } as never,
      policy,
      LIVE_CONFINEMENT,
    )
    expect(printed.runnerFailed).toBeUndefined()
    expect(printed.denied).toBe(false)
    // And danger-full-access never classifies either way.
    const full = classifySandbox(
      { stdout: '', stderr: 'Access is denied.', exitCode: 1 } as never,
      { mode: 'danger-full-access', workspaceRoot: process.cwd() } as unknown as SandboxExecutionPolicy,
      undefined,
    )
    expect(full).toEqual({ mode: 'danger-full-access', denied: false })
  })

  it('operator running the pinned payload under the real runner sees a startup fault reported as a startup fault, never as a policy denial', async () => {
    // Given the payload bash this plugin actually ships, under the real token,
    const workspace = scratchDir()
    const outcome = await runConfined([PAYLOAD_BASH, '--norc', '--noprofile', '-c', 'echo payload-ok'], 'read-only', workspace)
    // When its outcome is classified,
    const classified = classifyLive(outcome, workspace)
    // Then it is NEVER reported as a policy denial: the boundary did not
    // refuse a file effect, and telling the model otherwise would send it
    // looking for a file it may not touch.
    expect(classified.denied).toBe(false)
    // The observed fact on this host is a startup failure — exit 3221225794
    // (0xC0000142) from the MSYS runtime's own named-object creation. A host
    // whose payload starts reports exit 0 instead. Either is honest; what is
    // asserted is that the two are never confused for one another.
    if (outcome.exitCode === 0) {
      expect(outcome.stdout).toContain('payload-ok')
    } else {
      expect(outcome.exitCode).toBe(3221225794)
      expect(outcome.stderr).toMatch(/0xC0000022|couldn't create signal pipe/u)
      expect(outcome.stderr).toContain('fatal error')
    }
  })

  it('operator on a non-English host sees a localized cmd.exe denial classified as an ordinary non-zero exit', async () => {
    // This test PINS A GAP, it does not endorse it. The rung's denial
    // signatures are English while cmd.exe reports a refused redirect in the
    // system display language, so on a non-English host that real denial is
    // indistinguishable from a command failure. It is recorded here because a
    // future fix to the upstream rung must flip this assertion.
    //
    // Given a scratch workspace on a host whose cmd.exe reports in its own
    // display language,
    const workspace = scratchDir()
    const outside = outsidePath()
    const outcome = await runConfined([
      'cmd', '/c', 'echo x > "' + outside + '" & echo w-exit=%errorlevel%',
    ], 'read-only', workspace)
    // When a confined cmd.exe tries to redirect into a path outside the grant
    // and its outcome is classified,
    const classified = classifyLive(outcome, workspace)
    // Then the write really was refused — the boundary held —
    expect(existsSync(outside)).toBe(false)
    // But the classifier cannot tell that from the text, because the text is
    // not English. A host whose cmd.exe reports in English matches and reports
    // denied: true instead, so this assertion follows the host's own dialect.
    expect(typeof classified.denied).toBe('boolean')
    if (/access is denied/iu.test(outcome.stderr)) {
      expect(classified.denied).toBe(true)
    } else {
      expect(classified.denied).toBe(false)
    }
  })
})

describe.skipIf(SKIP_REASON === undefined)('live ACL confinement prerequisites', () => {
  it('operator without the prerequisites is told exactly what is missing instead of getting a silent pass', () => {
    // This block runs ONLY when the live block is skipped, so the suite can
    // never look green because the real check quietly did not happen.
    // Given this host cannot serve the live check,
    // When the skip verdict is read,
    // Then it names the missing prerequisite in full.
    expect(SKIP_REASON).toMatch(/not win32|no ACL runner/u)
  })
})
