/**
 * Confinement contract: a command a restricted session runs under goes
 * through the sandbox provider's confine step, and the CONFINED argv is what
 * gets spawned.
 *
 * This is a STRUCTURAL test, the shape this package already uses for the
 * sandbox seam (see ./gate.ts's mirror note): the provider is a fake that
 * records the argv it was handed and answers with a recognisable wrapped one.
 * What it certifies is that this plugin spawns the provider's answer rather
 * than the payload's own argv, on both the foreground and the background
 * path. The real ACL probe under a restricted session is a separate concern.
 *
 * The fake process never answers a handshake, so each call is cancelled once
 * the spawn has been observed: that ends the call deterministically instead of
 * waiting out a handshake deadline.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { resolveConfig } from '../src/config.ts'
import { ShellRegistry } from '../src/shell.ts'
import { buildWinBashTool } from '../src/tool.ts'

/** A subprocess seam that records the argv of every spawn. */
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
        // A process that never reports an outcome: every assertion here is
        // about the argv it was started with.
        done: new Promise(() => {}),
        terminate: () => {},
        waitForExit: async () => true,
      } as unknown as SubprocessHandle
    },
  }
  return { runtime: runtime as unknown as SubprocessRuntime, argv }
}

/** A confinement provider that wraps every argv it is handed. */
function recordingConfiner() {
  const handed: string[][] = []
  return {
    handed,
    provider: {
      confine: async (argv: readonly string[]) => {
        handed.push([...argv])
        return {
          argv: ['C:/runner.exe', '--policy', ...argv],
          enforcement: 'full' as const,
          denialSignatures: ['access is denied'],
          runnerFailureRules: [],
        }
      },
    },
  }
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

/** One macrotask turn, so a call's awaited chain reaches its spawn. */
function settleTurn(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve) })
}

const RUNTIME = { bash: 'C:/payload/bash.exe', bin: 'C:/payload/usr/bin' }
const PAYLOAD_ARGV = ['C:/payload/bash.exe', '--norc', '--noprofile', '-s']

/**
 * Run one foreground call far enough to observe its spawn, then cancel it.
 * @param tool - the shipped tool.
 * @param shells - the registry the call uses.
 */
async function queueOneCall(
  tool: { execute(args: unknown, exec: never): Promise<unknown> },
  shells: ShellRegistry,
): Promise<void> {
  const controller = new AbortController()
  const call = tool.execute({ command: 'echo hi' }, {
    agent: { id: 'session-1', session: { header: { cwd: process.cwd() } } },
    signal: controller.signal,
  } as never)
  const contained = call.then(() => undefined, () => undefined)
  await settleTurn()
  controller.abort()
  await contained
  await shells.disposeAll('test teardown')
}

describe('a confined foreground call', () => {
  it('operator on a restricted session sees the persistent shell spawned with the confined argv', async () => {
    // Given a session under a restricted mode, a confinement provider, and a
    // subprocess seam that records what it is asked to start,
    const subprocess = recordingSubprocess()
    const confiner = recordingConfiner()
    const shells = new ShellRegistry(subprocess.runtime)
    const tool = buildWinBashTool(
      context({ sandbox: confiner.provider, subprocess: subprocess.runtime, mode: 'read-only' }),
      resolveConfig(undefined),
      RUNTIME,
      shells,
    )
    // When the model runs a foreground command,
    await queueOneCall(tool, shells)
    // Then the provider was handed the payload's argv,
    expect(confiner.handed).toEqual([PAYLOAD_ARGV])
    // And the process actually started is the provider's wrapped argv — not the
    // payload's own, which would run the command outside the selected boundary.
    expect(subprocess.argv[0]).toEqual(['C:/runner.exe', '--policy', ...PAYLOAD_ARGV])
  })

  it('operator on a danger-full-access session sees the payload argv spawned unwrapped', async () => {
    // Given a session with no confinement at all,
    const subprocess = recordingSubprocess()
    const shells = new ShellRegistry(subprocess.runtime)
    const tool = buildWinBashTool(
      context({ subprocess: subprocess.runtime, mode: 'danger-full-access' }),
      resolveConfig(undefined),
      RUNTIME,
      shells,
    )
    // When the model runs a foreground command,
    await queueOneCall(tool, shells)
    // Then no confine step is involved and the payload's own argv is spawned.
    expect(subprocess.argv[0]).toEqual(PAYLOAD_ARGV)
  })
})
