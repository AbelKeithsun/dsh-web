/**
 * Host pwsh replacement: which sessions lose the host's PowerShell tool once
 * win_bash serves them, which do not, and what puts it back.
 *
 * The platform is passed EXPLICITLY in the module-level cases rather than read
 * from the runner, because the contract under test is "Windows hides, POSIX
 * does not" — a suite that inherited process.platform could only ever assert
 * one half of it. The mount cases do carry a Windows gate, since there the
 * decision is production's own.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installPwshReplacement, mountWithGate } from '../src/index.ts'
import { CONFIG_DEFAULTS, resolveConfig } from '../src/config.ts'
import { resolveRuntime } from '../src/runtime.ts'

const runtime = resolveRuntime({ platform: process.platform, arch: process.arch })
const isWindowsX64 = process.platform === 'win32' && process.arch === 'x64'

/** Gate deadlines small enough to exercise the bounded waits without a slow suite. */
const FAST_GATE = { settleTimeoutMs: 200, readTimeoutMs: 200, declarationWaitMs: 20, pollIntervalMs: 5 } as const

/** One session's scoped tools view, with the restriction it currently carries. */
interface Session {
  /** The names that session's model can currently see. */
  readonly names: string[]
  /** Every deny set that session's scope was restricted with. */
  readonly restrictions: string[][]
  /** How many times the session's restriction was lifted. */
  lifts: number
  /** The host event handlers the module installed, by event name. */
  readonly handlers: Map<string, (...args: any[]) => void>
}

/**
 * One stand-in session: a scoped tools view that records the restriction it
 * receives and lifts it the way the registry's own disposer would.
 * @param names - the tool names this session starts out seeing.
 * @returns the session, plus the agent object the host would hand the module.
 */
function session(names: readonly string[]): { agent: { ctx: { tools: { restrict: any } } }, state: Session } {
  const state: Session = { names: [...names], restrictions: [], lifts: 0, handlers: new Map() }
  const tools = {
    restrict: (filter: { deny: readonly string[] }) => {
      state.restrictions.push([...filter.deny])
      state.names.splice(0, state.names.length, ...state.names.filter(name => !filter.deny.includes(name)))
      return () => {
        state.lifts += 1
        state.names.splice(0, state.names.length, ...names)
      }
    },
  }
  return { agent: { ctx: { tools } }, state }
}

/** Everything one install run did, recorded instead of asserted on a mock. */
interface Recorded {
  /** The sessions this install may act on, in roster order. */
  readonly sessions: { agent: unknown, state: Session }[]
  /** Every registration the module installed, by event name. */
  readonly listeners: string[]
  /** Every fiber effect the module installed. */
  effects: number
  /** Warning lines the module emitted. */
  readonly warnings: string[]
  /** How many times a model-facing surface was read. */
  schemaReads: number
  /** How many times the session roster was read. */
  rosterReads: number
}

/**
 * A structural host context publishing one tools service and one session
 * roster, with no real cordis behind it.
 * @param sessions - the sessions this host serves.
 * @param options - rosterThrows: refuse every roster read.
 * @returns the context and the sink its interactions are recorded in.
 */
function hostContext(
  sessions: { agent: unknown, state: Session }[] = [],
  options: { rosterThrows?: boolean } = {},
): { ctx: Context, recorded: Recorded } {
  const recorded: Recorded = {
    sessions, listeners: [], effects: 0, warnings: [], schemaReads: 0, rosterReads: 0,
  }
  const byAgent = new Map(sessions.map(entry => [entry.agent, entry.state]))
  const context = {
    logger: { info: () => {}, warn: (message: string) => { recorded.warnings.push(message) }, error: () => {} },
    get: (service: string) => {
      if (service === 'tools') {
        return {
          schemas: (agent?: unknown) => {
            recorded.schemaReads += 1
            return (byAgent.get(agent)?.names ?? []).map(name => ({ name }))
          },
        }
      }
      if (service !== 'agents') return undefined
      return {
        list: () => {
          recorded.rosterReads += 1
          if (options.rosterThrows === true) throw new Error('roster unavailable')
          return sessions.map(entry => entry.agent)
        },
      }
    },
    on: (event: string, handler: (...args: any[]) => void) => {
      recorded.listeners.push(event)
      for (const entry of sessions) entry.state.handlers.set(event, handler)
      return () => {}
    },
    effect: (body: () => unknown) => { recorded.effects += 1; return body() },
  } as unknown as Context
  return { ctx: context, recorded }
}

describe('the host pwsh replacement on Windows', () => {
  it('operator whose session sees pwsh loses that one tool and keeps every other', () => {
    // Given a Windows host whose session surface carries the private shell,
    // the host shell, and an unrelated tool,
    const { agent, state } = session(['win_bash', 'pwsh', 'read'])
    const { ctx } = hostContext([{ agent, state }])
    // When the replacement is installed for Windows,
    installPwshReplacement(ctx, { platform: 'win32' })
    // Then exactly pwsh was withdrawn from that session and nothing else was
    // touched, so the model still sees the shell replacement and the files.
    expect(state.restrictions).toEqual([['pwsh']])
    expect(state.names).toEqual(['win_bash', 'read'])
  })

  it('operator sees the host shell come back when that session is disposed', () => {
    // Given a session whose pwsh was withdrawn,
    const { agent, state } = session(['win_bash', 'pwsh'])
    const { ctx } = hostContext([{ agent, state }])
    installPwshReplacement(ctx, { platform: 'win32' })
    // When that session ends,
    state.handlers.get('agent/disposed')?.({ agent })
    // Then the restriction was lifted exactly once and the host shell is back
    // on the session's surface.
    expect(state.lifts).toBe(1)
    expect(state.names).toEqual(['win_bash', 'pwsh'])
  })

  it('operator whose session never saw pwsh gets no restriction at all', () => {
    // Given a session whose surface carries win_bash and nothing else,
    const { agent, state } = session(['win_bash'])
    const { ctx } = hostContext([{ agent, state }])
    // When the replacement is installed,
    installPwshReplacement(ctx, { platform: 'win32' })
    // Then nothing is restricted and nothing is reported: a registry that does
    // not know the name would refuse the filter, and "not registered" is an
    // ordinary state rather than a defect.
    expect(state.restrictions).toEqual([])
    expect(state.names).toEqual(['win_bash'])
  })

  it('operator mounting before the host shell row registers still gets it hidden when it lands', () => {
    // Given a session whose surface does not carry pwsh yet, because the
    // host's own shell row mounts in a later loader group,
    const { agent, state } = session(['win_bash'])
    const { ctx, recorded } = hostContext([{ agent, state }])
    installPwshReplacement(ctx, { platform: 'win32' })
    expect(recorded.listeners).toContain('tools/change')
    expect(state.restrictions).toEqual([])
    // When that row lands and the registry announces the surface change,
    state.names.push('pwsh')
    state.handlers.get('tools/change')?.()
    // Then the session loses pwsh from that moment on, with no boot-time wait
    // and no poll.
    expect(state.restrictions).toEqual([['pwsh']])
    expect(state.names).toEqual(['win_bash'])
  })

  it('operator unloading the plugin gets the host shell back for every session it hid', () => {
    // Given two sessions whose pwsh was withdrawn and a third that never had
    // it on the surface,
    const a = session(['win_bash', 'pwsh'])
    const b = session(['win_bash', 'pwsh'])
    const c = session(['win_bash'])
    const { ctx, recorded } = hostContext([a, b, c])
    let unload: (() => void) | undefined
    ;(ctx as unknown as { effect: (body: () => unknown) => unknown }).effect = (body) => {
      recorded.effects += 1
      const disposer = body()
      if (typeof disposer === 'function') unload = disposer as () => void
      return disposer
    }
    installPwshReplacement(ctx, { platform: 'win32' })
    expect(a.state.names).toEqual(['win_bash'])
    expect(c.state.restrictions).toEqual([])
    // When the plugin fiber unloads,
    unload?.()
    // Then every session has the host shell back, and the one that never lost
    // it is unchanged.
    expect(a.state.names).toEqual(['win_bash', 'pwsh'])
    expect(b.state.names).toEqual(['win_bash', 'pwsh'])
    expect(c.state.names).toEqual(['win_bash'])
  })

  it('operator whose session roster cannot be read keeps the host shell and gets a warning', () => {
    // Given a deployment whose agent registry refuses its own roster read,
    const { ctx, recorded } = hostContext([], { rosterThrows: true })
    // When the replacement is installed,
    installPwshReplacement(ctx, { platform: 'win32' })
    // Then it reports the reach it did not have, instead of failing silently
    // or restricting a surface nobody read.
    expect(recorded.warnings.length).toBeGreaterThan(0)
    expect(recorded.warnings.join('\n')).toContain('could not be read')
    expect(recorded.schemaReads).toBe(0)
  })

  it('operator whose session exposes no scoped tools view keeps the host shell and gets a warning', () => {
    // Given a session that exposes no scoped view to restrict through,
    const state: Session = { names: ['win_bash', 'pwsh'], restrictions: [], lifts: 0, handlers: new Map() }
    const agent = { ctx: {} }
    const { ctx, recorded } = hostContext([{ agent, state }])
    // When the replacement is installed,
    installPwshReplacement(ctx, { platform: 'win32' })
    // Then no restriction is attempted and the operator is told why the host
    // shell is still listed.
    expect(state.restrictions).toEqual([])
    expect(recorded.warnings.join('\n')).toContain('no scoped tools view')
  })
})

describe('the host pwsh replacement off Windows', () => {
  it('operator on a POSIX host gets no listener, no effect and no restriction', () => {
    // Given a POSIX host whose session surface would match the deny name,
    const { agent, state } = session(['win_bash', 'pwsh'])
    const { ctx, recorded } = hostContext([{ agent, state }])
    // When the replacement is installed there,
    installPwshReplacement(ctx, { platform: 'linux' })
    // Then not one side effect was produced: no event listener, no fiber
    // effect, no surface read, no roster read, and no restriction. The Windows
    // ladder must not reach a POSIX deployment at all.
    expect(recorded.listeners).toEqual([])
    expect(recorded.effects).toBe(0)
    expect(recorded.schemaReads).toBe(0)
    expect(recorded.rosterReads).toBe(0)
    expect(state.restrictions).toEqual([])
    expect(state.names).toEqual(['win_bash', 'pwsh'])
  })

  it('operator on macOS gets the same total no-op, and a later session is unaffected', () => {
    // Given a macOS host where the install produced nothing,
    const { ctx, recorded } = hostContext([])
    installPwshReplacement(ctx, { platform: 'darwin' })
    // When a session starts afterwards and the host would have announced it,
    const { agent, state } = session(['win_bash', 'pwsh'])
    recorded.sessions.push({ agent, state })
    // Then there is no listener registered to receive that event, so the later
    // session keeps the surface it was composed with.
    expect(recorded.listeners).toEqual([])
    expect(recorded.effects).toBe(0)
    expect(state.restrictions).toEqual([])
    expect(state.names).toEqual(['win_bash', 'pwsh'])
  })
})

describe('the replacement follows the win_bash mount', () => {
  const gateIt = isWindowsX64 ? it : it.skip

  /**
   * A context that records the registrations one gate verdict produces.
   * @param declaring - whether the stand-in preset roster declares liangshen.
   * @returns the context, the registered names, and the session's state.
   */
  function mountContext(declaring: boolean) {
    const { agent, state } = session(['win_bash', 'pwsh'])
    const { ctx } = hostContext([{ agent, state }])
    const registered: string[] = []
    const context = {
      ...(ctx as unknown as Record<string, unknown>),
      tools: { register: (tool: { name: string }) => { registered.push(tool.name); return () => {} } },
      subprocess: { spawn: () => { throw new Error('this host must never reach a spawn') } },
      get: (service: string) => {
        if (service === 'agentPresets') return { list: async () => [{ id: declaring ? 'liangshen' : 'standard' }] }
        return (ctx as unknown as { get: (key: string) => unknown }).get(service)
      },
    } as unknown as Context
    return { context, registered, state }
  }

  gateIt('operator whose gate admits win_bash gets the host pwsh tool withdrawn in the same mount', async () => {
    // Given a Windows deployment that declares the liangshen preset,
    const { context, registered, state } = mountContext(true)
    if ('code' in runtime) throw new Error('this host cannot serve the vendored payload')
    // When the entry mounts,
    await mountWithGate(context, resolveConfig(undefined), runtime, FAST_GATE)
    // Then win_bash is on the wire and pwsh is not: the ladder's top rung is
    // the only shell the session is offered.
    expect(registered).toEqual(['win_bash'])
    expect(state.restrictions).toEqual([['pwsh']])
    expect(state.names).toEqual(['win_bash'])
  })

  gateIt('operator whose gate refuses win_bash keeps the host pwsh tool untouched', async () => {
    // Given a Windows deployment whose roster declares no liangshen preset,
    const { context, registered, state } = mountContext(false)
    if ('code' in runtime) throw new Error('this host cannot serve the vendored payload')
    // When the entry mounts,
    await mountWithGate(context, resolveConfig(undefined), runtime, FAST_GATE)
    // Then nothing registered AND nothing was hidden: withdrawing the only
    // usable shell of a deployment that ends up with no replacement shell
    // would leave the session with neither.
    expect(registered).toEqual([])
    expect(state.restrictions).toEqual([])
    expect(state.names).toEqual(['win_bash', 'pwsh'])
  })

  gateIt('operator turning replacement off gets both shells side by side', async () => {
    // Given a deployment that declares the preset and opts out of replacement,
    const { context, registered, state } = mountContext(true)
    if ('code' in runtime) throw new Error('this host cannot serve the vendored payload')
    // When the entry mounts,
    await mountWithGate(context, resolveConfig({ replacePwsh: false }), runtime, FAST_GATE)
    // Then win_bash registers and pwsh stays exactly where it was.
    expect(registered).toEqual(['win_bash'])
    expect(state.restrictions).toEqual([])
    expect(state.names).toEqual(['win_bash', 'pwsh'])
  })
})

describe('the shipped description states the shell preference', () => {
  it('operator reading the catalog-truncated description sees the preference inside 200 characters', () => {
    // Given the tool description a preset catalog truncates at 200 characters,
    const description = CONFIG_DEFAULTS.description
    const visible = description.slice(0, 200)
    // When that visible window is read,
    // Then it names this tool as the one for command work and points at pwsh
    // as the narrower tool, without depending on a sentence the cut removes.
    expect(visible).toContain('pinned bash shell')
    expect(visible).toContain('prefer it over pwsh')
    // And the full text still carries the persistence guarantee it shipped with.
    expect(description).toContain('persist across win_bash calls')
    expect(description).toContain('real exit code')
    expect(/^[\x20-\x7e]+$/u.test(description)).toBe(true)
  })
})
