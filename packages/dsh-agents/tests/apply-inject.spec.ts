/**
 * The row's mount under a cordis context that enforces its inject list.
 *
 * A cordis fiber may read only a service it injected; a read of any other
 * service name throws `cannot get property "<name>" without inject` from the
 * cordis resolve trap. This row injects three services and READS five optional
 * Team-runtime services, so this suite models the deployments that have to
 * mount: one that serves none of the five, one that serves all five, and a
 * context whose services are reachable through `ctx.get` only. The first case
 * is the regression: a plain property read of `agents` turned the optional
 * probe into a fatal apply error, and the page then reported that the Host API
 * was not mounted at all.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, inject, servesTeamRuntime } from '../src/index.ts'
import { DSH_AGENTS_ROUTE_PATHS } from '../src/protocol.ts'
import { TeamService, type TeamServiceContext } from '../src/team/index.ts'
import { installTeamTools } from '../src/tools/index.ts'

/** One registered projection definition. */
type Projection = { key: string; stateVersion: number }

/** How the fake answers a property read of a service it serves. */
interface FakeHostOptions {
  /**
   * Answer property reads of served services with the cordis error instead.
   *
   * A sibling plugin's fiber can read no service it did not inject, which is
   * the shape under test; the default answers them, the way a context that
   * provides the service itself does.
   */
  readonly strictPropertyReads?: boolean
}

/** Everything a spec observes about the fake Host. */
interface FakeHost {
  readonly ctx: Context
  /** Path of every route the row registered with `ctx.webServer`. */
  readonly routes: string[]
  /** First argument of every `ctx.logger.warn` call. */
  readonly warnings: string[]
  /** Drop everything the row disposed through `ctx.effect`. */
  release(): void
}

/** The five Team-runtime services a deployment can serve. */
function servedTeamServices(projections: Projection[]): Record<string, unknown> {
  return {
    agents: { get: () => undefined, list: () => [] },
    sessions: { get: () => undefined, flush: async () => undefined },
    sessionPersistence: { open: async () => undefined },
    sessionProjections: {
      register: (definition: Projection): (() => void) => {
        projections.push({ key: definition.key, stateVersion: definition.stateVersion })
        return () => undefined
      },
      stateOf: () => undefined,
    },
    subagents: {
      startActivation: async () => undefined,
      drainChildren: async () => undefined,
      interrupt: () => undefined,
    },
  }
}

/**
 * Build the fake Host context.
 *
 * Own properties are the row's inject list plus the context members every
 * plugin uses (`effect`, `on`, `get`, `logger`, and the `reflect`/`fiber` pair a
 * `Service` constructor registers itself through). Every other service name
 * throws cordis' own error unless this fake serves it and answers property
 * reads.
 * @param services - the services this fake deployment serves.
 * @param options - how served services answer a property read.
 * @returns the context and the observation log.
 */
function createFakeHost(services: Record<string, unknown> = {}, options: FakeHostOptions = {}): FakeHost {
  const routes: string[] = []
  const warnings: string[] = []
  const disposers: Array<() => unknown> = []
  const available = new Map<string, unknown>(Object.entries(services))

  const systemPrompt = {
    section: () => () => undefined,
    context: () => () => undefined,
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
  }
  const webServer = {
    register: (route: { path: string }): (() => void) => {
      routes.push(route.path)
      return () => undefined
    },
  }
  const target: Record<string, unknown> = {
    effect: (callback: () => unknown): (() => void) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => unknown)
      return () => undefined
    },
    on: () => () => undefined,
    get: (name: string) => available.get(name),
    logger: { warn: (message: unknown) => { warnings.push(String(message)) } },
    fiber: { effect: (callback: () => unknown) => callback() },
    reflect: {
      provide: (name: string, value: unknown): (() => void) => {
        available.set(name, value)
        return () => { available.delete(name) }
      },
    },
  }
  // The injectable surface is the row's own declared list, so this fake cannot
  // drift from the services the row promises to inject.
  for (const name of inject) {
    target[name] = name === 'webServer' ? webServer : name === 'systemPrompt' ? systemPrompt : undefined
  }

  let ctx: Context
  const proxy = new Proxy(target, {
    get(inner, property) {
      if (typeof property === 'symbol' || property === 'then' || property.startsWith('_')) {
        return Reflect.get(inner, property)
      }
      if (Reflect.has(inner, property)) return Reflect.get(inner, property)
      if (property === 'root') return proxy
      if (available.has(property) && options.strictPropertyReads !== true) return available.get(property)
      throw new Error(`cannot get property "${property}" without inject`)
    },
  })
  ctx = proxy as unknown as Context
  // `ctx.root` is the context a `Service` registers its root projection on.
  target.root = proxy

  return {
    ctx,
    routes,
    warnings,
    release: () => {
      for (const dispose of disposers.splice(0)) {
        try {
          void Promise.resolve(dispose()).catch(() => undefined)
        } catch {
          // Disposing the fake Host is best-effort; the assertions already ran.
        }
      }
    },
  }
}

let home: string
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-agents-inject-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('row mount under an inject-enforcing context', () => {
  it('operator mounts the ledger routes and skips the forked team runtime when a deployment serves none of its five services', () => {
    // Given a Host that serves none of the five Team-runtime services, When the row applies, Then every ledger route registers, the Team runtime stays unmounted with one warning, and no property read can fail the mount.
    const host = createFakeHost()

    // The exact production failure: a service the fiber did not inject.
    expect(() => Reflect.get(host.ctx as object, 'agents')).toThrow('cannot get property "agents" without inject')
    expect(servesTeamRuntime(host.ctx)).toBe(false)

    expect(() => apply(host.ctx, { enabled: true })).not.toThrow()
    expect(host.routes).toEqual([...DSH_AGENTS_ROUTE_PATHS])
    expect(host.warnings.some(message => message.includes('forked Agent Teams runtime stays unmounted'))).toBe(true)
    host.release()
  })

  it('operator mounts the forked team runtime exactly once when the deployment serves all five services', () => {
    // Given a Host that serves all five, When the row applies, Then the same routes register and the Team service registers its one agentTeam projection.
    const projections: Projection[] = []
    const host = createFakeHost(servedTeamServices(projections))

    expect(servesTeamRuntime(host.ctx)).toBe(true)
    expect(() => apply(host.ctx, { enabled: true })).not.toThrow()
    expect(host.routes).toEqual([...DSH_AGENTS_ROUTE_PATHS])
    expect(projections).toEqual([{ key: 'agentTeam', stateVersion: 4 }])
    expect(host.warnings.some(message => message.includes('forked Agent Teams runtime stays unmounted'))).toBe(false)
    host.release()
  })

  it('operator installs the Team tool surface through the service accessor when served services are not readable as properties', () => {
    // Given a context that reaches agentTeams and agents only through ctx.get, When the installer runs, Then it scans the live agents instead of throwing on a property read.
    const projections: Projection[] = []
    const host = createFakeHost(
      { ...servedTeamServices(projections), agentTeams: { tryMembership: () => undefined } },
      { strictPropertyReads: true },
    )
    expect(() => Reflect.get(host.ctx as object, 'agentTeams')).toThrow('cannot get property "agentTeams" without inject')

    const installation = installTeamTools(host.ctx as unknown as TeamServiceContext, { isTeamSession: () => false })
    expect(() => installation.refresh()).not.toThrow()
    installation.dispose()
    host.release()
  })
})

describe('team runtime mount on a real cordis tree', () => {
  it('operator mounts the Team service on the row fiber when a sibling fiber provides the five services', async () => {
    // Given a real cordis tree whose five Team services are provided by a sibling fiber, When the Team service is constructed on a fiber that injects only the row's three services, Then it constructs, registers its one projection, and answers Lead membership.
    const root = new Context()
    const projections: Projection[] = []
    const lead = {
      id: 'lead-session',
      session: {
        header: { id: 'lead-session' },
        inheritedEventCount: 0,
        snapshotEvents: () => [],
      },
      options: {},
    } as unknown as Agent

    root.plugin({
      name: 'fake-host-services',
      apply(provider: Context) {
        provider.provide('systemPrompt', {
          section: () => () => undefined,
          context: () => () => undefined,
          getSectionOrder: () => 0,
          getContextOrder: () => 0,
        })
        provider.provide('typertGateway', {})
        provider.provide('webServer', { register: () => () => undefined })
        provider.provide('agents', {
          get: (id: string) => (id === lead.id ? lead : undefined),
          list: () => [lead],
        })
        provider.provide('sessions', { get: () => undefined, flush: async () => undefined })
        provider.provide('sessionPersistence', { open: async () => undefined })
        provider.provide('sessionProjections', {
          register: (definition: Projection) => {
            projections.push({ key: definition.key, stateVersion: definition.stateVersion })
            return () => undefined
          },
          stateOf: () => undefined,
        })
        provider.provide('subagents', {
          startActivation: async () => undefined,
          drainChildren: async () => undefined,
          interrupt: () => undefined,
        })
      },
    })

    let team: TeamService | undefined
    let failure: unknown
    root.plugin({
      name: 'dsh-agents-row',
      inject: [...inject],
      apply(row: Context) {
        try {
          team = new TeamService(row)
        } catch (error) {
          failure = error
        }
      },
    })

    // The mount's own output is the projection registration, so wait on that
    // condition - bounded, so a regressed mount fails here instead of hanging -
    // rather than on a fixed wall-clock delay.
    await vi.waitFor(() => {
      expect(projections).toHaveLength(1)
    })

    expect(failure).toBeUndefined()
    const instance = team
    if (instance === undefined) throw new Error('the row fiber never constructed the Team service')
    // The constructor's real output is asserted, not merely its existence.
    expect(instance).toBeInstanceOf(TeamService)
    expect(projections).toEqual([{ key: 'agentTeam', stateVersion: 4 }])
    expect(instance.membership(lead).role).toBe('lead')
  })
})
