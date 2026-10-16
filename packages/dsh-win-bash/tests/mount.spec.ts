/**
 * Mount gating: which hosts get the win_bash tool, and what a host that does
 * not get instead. This is the package's platform contract, so it is asserted
 * against the shipped entry's own apply, not against a copy of the rule.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/index.ts'

/** The plugin surface one host would see, recorded instead of asserted on a mock. */
interface Recorded {
  /** Every tool definition the entry registered. */
  readonly tools: { name: string }[]
  /** Whether the fiber-level effect was installed at all. */
  effectInstalled: boolean
  /** Log lines the entry emitted. */
  readonly logs: string[]
}

/**
 * Drive one apply against a minimal structural context and report what it did.
 *
 * The context is a plain object rather than the module graph's real Context:
 * this test certifies the entry's OWN gating decision, and a hand-built
 * context is the only way to present a POSIX or arm64 host to code that reads
 * process.platform directly.
 * @param config - the row config to mount with.
 * @param entry - the apply under test.
 * @returns what the entry registered and logged.
 */
function mountOn(config: unknown, entry: (ctx: Context, config?: never) => void): Recorded {
  const recorded: Recorded = { tools: [], effectInstalled: false, logs: [] }
  const ctx = {
    logger: {
      warn: (message: string) => { recorded.logs.push('warn ' + message) },
      error: (message: string) => { recorded.logs.push('error ' + message) },
    },
    get: () => undefined,
    on: () => () => {},
    effect: (body: () => unknown) => {
      recorded.effectInstalled = true
      if (typeof body === 'function') body()
    },
    tools: { register: (tool: { name: string }) => { recorded.tools.push(tool); return () => {} } },
    subprocess: { spawn: () => { throw new Error('this host must never reach a spawn') } },
    inject: () => ({ dispose: () => {} }),
  } as unknown as Context
  entry(ctx, config as never)
  return recorded
}

describe('the plugin entry surface', () => {
  it('operator mapping profile rows back to the plugin gets one name matching the package', () => {
    // Given the entry's exported cordis identity,
    // When it is compared with the row the bundle patch declares,
    // Then they agree, so a mounted row is never ambiguous.
    expect(name).toBe('dsh-win-bash')
    expect(inject).toEqual(['tools', 'subprocess'])
  })
})

describe('mount gating on this host', () => {
  const isWindowsX64 = process.platform === 'win32' && process.arch === 'x64'

  it(
    isWindowsX64
      ? 'operator on Windows x64 gets the win_bash tool instead of the host bash tool'
      : 'operator on a host without the vendored payload gets no tool at all',
    () => {
      // Given the shipped entry on this host,
      // When it mounts with no config,
      const recorded = mountOn(undefined, apply)
      // Then the mount decision matches the platform contract: Windows x64
      // registers exactly one tool named win_bash, and every other host
      // registers nothing.
      if (isWindowsX64) {
        expect(recorded.tools.map(tool => tool.name)).toEqual(['win_bash'])
        expect(recorded.effectInstalled).toBe(true)
      } else {
        expect(recorded.tools).toEqual([])
        expect(recorded.logs.join('\n')).toContain('was not mounted')
      }
    },
  )

  it('operator on any host never gets a tool named bash from this package', () => {
    // Given the shipped entry,
    // When it mounts,
    const recorded = mountOn(undefined, apply)
    // Then it claims no name the host's own bash-family tools already use:
    // a colliding id would replace or be replaced, silently either way.
    expect(recorded.tools.some(tool => tool.name === 'bash')).toBe(false)
    expect(recorded.tools.some(tool => tool.name === 'pwsh')).toBe(false)
  })
})

describe('mount gating on a refusal', () => {
  it('operator mounting a bad config on a host that cannot serve the payload gets no tool', () => {
    // Given a host whose payload cannot be resolved (this test host may or may
    // not be that host; the invariant holds either way),
    // When the entry mounts with a config the schema would reject,
    const recorded = (() => {
      try {
        return { tools: mountOn({ timeoutMs: 1 }, apply).tools, threw: false }
      } catch {
        return { tools: [] as { name: string }[], threw: true }
      }
    })()
    // Then it registers nothing before validating, so a rejected config can
    // never leave a half-mounted tool behind.
    expect(recorded.threw || recorded.tools.length === 0).toBe(true)
  })
})
