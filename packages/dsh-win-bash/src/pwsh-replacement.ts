/**
 * Host pwsh replacement: while this plugin's win_bash tool serves a session,
 * the host's own PowerShell tool comes off that session's model-facing
 * surface.
 *
 * WHY. The session then carries two shells, and nothing in either tool's
 * schema says which one to reach for first: a model defaults to the shell it
 * knows, which on Windows is pwsh, so bash-syntax commands keep arriving at a
 * PowerShell that answers them with a syntax error. Hiding pwsh is what makes
 * the preference structural instead of advisory — the ladder is win_bash
 * first, and pwsh stays the fallback for the Windows-native work only it can
 * do.
 *
 * WINDOWS ONLY. The ladder this module encodes is a Windows fact: win_bash is
 * the pinned MSYS2 shell a Windows session gets, and the host shell beside it
 * is PowerShell. POSIX sessions keep exactly the behavior they had — the
 * host's shell there is bash, which is not on the deny list in any case, and
 * this module returns before it reads, listens to, or restricts anything.
 *
 * VISIBILITY ONLY, DELIBERATELY. This module withdraws the tool from the wire
 * and from the generated SDK; it installs no execution guard and no
 * pre-execute denial. A model that has a reason to call pwsh anyway — a
 * Windows-native cmdlet, or a fallback after win_bash failed — must still
 * reach it, which is the ladder's lower rung. A hard refusal here would trade
 * a preference for a capability loss.
 *
 * SCOPED, NEVER GLOBAL. The restriction is installed through each agent's own
 * scoped tools view (`agent.ctx.tools.restrict`), so it covers exactly the
 * sessions win_bash serves and nothing else in the process. A deployment that
 * mounts no win_bash (a refused gate, a missing payload, a non-Windows host,
 * or `replacePwsh: false`) never calls this module at all.
 *
 * TIMING. The host's pwsh is registered by the host's own composition, whose
 * group can settle after this plugin mounts, so a name that is not on the
 * readable surface yet is not a verdict: the registry's own `tools/change`
 * event retries every agent still without a restriction. Nothing here waits,
 * polls, or holds a boot path open.
 *
 * LIFECYCLE. Every restriction is remembered per agent scope and lifted when
 * that agent is disposed or when this plugin unloads, one isolated callback at
 * a time: a throwing lift must not leave the remaining sessions with a shell
 * they cannot see, and it must not leave the map holding a dead scope.
 * @module @linxin666/dsh-win-bash/pwsh-replacement
 */

import type { Context } from '@deepseek-ai/cordis'

/** The host tool this module withdraws while win_bash is mounted. */
export const HOST_PWSH_TOOL = 'pwsh'

/** The scoped restriction call this module consumes from an agent's tools view. */
export interface ScopedRestrictor {
  /**
   * Mask global tool names for the calling agent scope.
   * @param filter - the mask; only `deny` is used here.
   * @returns the exact disposer that lifts the restriction.
   */
  restrict(filter: { deny: readonly string[] }): () => void
}

/** One agent scope, as much of it as this module reads. */
interface AgentScopeLike {
  /** The agent's own scoped context, when it exposes one. */
  readonly ctx?: { readonly tools?: ScopedRestrictor }
}

/** The registry read this module consumes. */
interface SurfaceReader {
  /** The model-facing surface one scope sees, or the global view when omitted. */
  schemas(agent?: unknown): unknown
}

/** What one install run reports and where. */
export interface PwshReplacementOptions {
  /**
   * The host platform this run may act on; defaults to `process.platform`.
   * Any value other than `win32` makes the call a total no-op, so no POSIX
   * deployment can acquire a restriction, a listener, or a disposer from this
   * module. Tests pass it explicitly instead of depending on the runner's own
   * platform.
   */
  readonly platform?: string
  /** Tool names to withdraw; defaults to {@link HOST_PWSH_TOOL}. */
  readonly denied?: readonly string[]
  /**
   * One-time warning sink. The default writes through the plugin logger; a
   * caller may replace it so a host with no logger still sees the message.
   */
  readonly warn?: (message: string) => void
}

/** The message of a thrown value, whatever it is. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One optional service, read without letting a refused lookup escape.
 * @param ctx - the plugin context.
 * @param name - the service name.
 * @returns the service, or undefined when it is not resolvable.
 */
function readService(ctx: Context, name: string): unknown {
  try {
    return (ctx as unknown as { get(key: string): unknown }).get(name)
  } catch {
    return undefined
  }
}

/**
 * The tool names one agent scope currently sees.
 * @param ctx - the plugin context.
 * @param agent - the scope to read for.
 * @returns the names, or undefined when no usable projection is readable.
 */
function visibleNames(ctx: Context, agent: unknown): readonly string[] | undefined {
  const service = readService(ctx, 'tools') as SurfaceReader | undefined
  if (service === null || typeof service !== 'object' || typeof service.schemas !== 'function') return undefined
  try {
    const schemas = service.schemas(agent)
    if (!Array.isArray(schemas)) return undefined
    return schemas
      .map(schema => (schema as { name?: unknown } | undefined)?.name)
      .filter((name): name is string => typeof name === 'string' && name !== '')
  } catch {
    return undefined
  }
}

/**
 * Withdraw {@link HOST_PWSH_TOOL} from every session this plugin serves, and
 * remember how to give it back.
 *
 * Called from the mount path ONLY after win_bash itself registered, so a
 * deployment that ends up without win_bash keeps the host's shell untouched.
 * @param ctx - context carrying tools and the agent registry.
 * @param options - the names to withdraw and the warning sink.
 */
export function installPwshReplacement(ctx: Context, options: PwshReplacementOptions = {}): void {
  // Checked FIRST, before the roster read, the listeners, and the effect: on a
  // POSIX host this call must leave no trace at all, so an early return above
  // every side effect is the only shape that satisfies it.
  if ((options.platform ?? process.platform) !== 'win32') return

  const denied = [...(options.denied ?? [HOST_PWSH_TOOL])]
  /** Agent scope -> the live disposer that lifts its restriction. */
  const lifts = new Map<AgentScopeLike, () => void>()
  /** Every scope this install has seen, so a later registration can be caught. */
  const seen = new Set<AgentScopeLike>()
  let warned = false
  const warn = (message: string): void => {
    if (options.warn !== undefined) {
      try {
        options.warn(message)
      } catch {
        // A broken sink must not become a new failure.
      }
      return
    }
    ctx.logger?.warn?.(message)
  }
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    warn(message)
  }

  /**
   * Lift one scope's restriction, isolating the callback: this restores a
   * shell the session should have back, so a throwing disposer must not stop
   * the ones after it nor keep this scope in the map.
   * @param scope - the agent scope to release.
   */
  const lift = (scope: AgentScopeLike): void => {
    const dispose = lifts.get(scope)
    lifts.delete(scope)
    seen.delete(scope)
    if (typeof dispose !== 'function') return
    try {
      dispose()
    } catch (error) {
      warn('dsh-win-bash: the host pwsh tool could not be restored for one session ('
        + messageOf(error) + '); pwsh stays hidden there until the next mount.')
    }
  }

  /**
   * Install one scope's restriction when that scope actually sees the tool.
   *
   * The visible surface is read first because `restrict()` refuses a name the
   * registry does not know as a global tool — and "not registered yet" is an
   * ordinary boot state here, not a defect, which is why this retries off
   * `tools/change` instead of reporting it.
   * @param agent - the scope to hide the host shell from.
   */
  const hide = (agent: unknown): void => {
    if (agent === null || typeof agent !== 'object') return
    const scope = agent as AgentScopeLike
    seen.add(scope)
    if (lifts.has(scope)) return
    const names = denied.filter(name => (visibleNames(ctx, agent) ?? []).includes(name))
    if (names.length === 0) return
    const restrict = scope.ctx?.tools?.restrict
    if (typeof restrict !== 'function') {
      warnOnce('dsh-win-bash: this deployment exposes no scoped tools view, so the host pwsh tool stays visible beside win_bash.')
      return
    }
    // Reserve the slot BEFORE restricting: the registry emits `tools/change`
    // for a restriction change, and a listener that re-entered here with the
    // slot still empty would restrict the same scope again, forever.
    lifts.set(scope, () => {})
    let dispose: unknown
    try {
      dispose = restrict.call(scope.ctx?.tools, { deny: names })
    } catch (error) {
      lifts.delete(scope)
      warnOnce('dsh-win-bash: the host pwsh tool could not be withdrawn from this session ('
        + messageOf(error) + '); pwsh stays visible beside win_bash.')
      return
    }
    if (typeof dispose !== 'function') {
      lifts.delete(scope)
      warnOnce('dsh-win-bash: the tool registry did not confirm the pwsh restriction, so pwsh stays visible beside win_bash.')
      return
    }
    lifts.set(scope, dispose as () => void)
  }

  // The created listener returns undefined explicitly: the event is declared
  // serial, so its listeners are typed as returning `undefined | Promise<undefined>`
  // and a bare void arrow is not assignable to that.
  ctx.on('agent/created', ({ agent }) => {
    hide(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => { lift(agent as AgentScopeLike) })
  // The host's own shell row may mount after this one. A name that is not on
  // the surface yet is caught here rather than guessed at mount time.
  ctx.on('tools/change', () => {
    for (const scope of [...seen]) hide(scope)
  })

  // Sessions that were already running when this plugin mounted.
  const registry = readService(ctx, 'agents') as { list?: () => unknown[] } | undefined
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      for (const agent of registry.list() ?? []) hide(agent)
    } catch (error) {
      warnOnce('dsh-win-bash: the session roster could not be read, so the host pwsh tool stays visible in sessions that were already open ('
        + messageOf(error) + ').')
    }
  }

  ctx.effect(() => () => {
    // Snapshot first: `lift` deletes from the map it is iterating.
    for (const scope of [...lifts.keys()]) lift(scope)
  }, 'dsh-win-bash: host pwsh replacement')
}
