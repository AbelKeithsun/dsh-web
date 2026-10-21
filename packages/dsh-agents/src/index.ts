/**
 * Host entry of the dsh-agents plugin: one ledger, the seven squad routes, the
 * member-brief section, the squad context that tells a Lead who exists, and the
 * forked Agent Teams runtime that makes a squad run real.
 *
 * This file wires faces the Host already serves; every rule it depends on lives
 * beside it — the ledger in host/ledger.ts, the definition/run seam in
 * host/run-gateway.ts, the launch order in host/service.ts, the squad-run gate
 * and Lead context in host/squad.ts, the fence and the wire in host/routes.ts and
 * protocol.ts, the injection decision in host/member-prompt.ts (evidence in
 * docs/member-prompt.md), and the fork itself in team/ and tools/ (provenance in
 * docs/fork-provenance.md).
 *
 * @module @linxin666/dsh-agents
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { agentsHomeDirectory } from './host/home.ts'
import { assembleIdentity, registerMemberPromptSeam, type MemberPromptRegistry } from './host/member-prompt.ts'
import { makeAgentsRoutes } from './host/routes.ts'
import { createHostRunGateway, createTeammatePins, type CommandDispatcherFace, type TypertGatewayFace, type WorkspaceRegistryFace } from './host/run-gateway.ts'
import { AgentsHostService } from './host/service.ts'
import { TeamService, type TeamServiceContext } from './team/index.ts'
import { installTeamTools, type TeamToolInstallation } from './tools/index.ts'

/** Services this row needs before it mounts. The workspace registry, command dispatcher and agent registry are resolved optionally: a deployment that lacks one still mounts, and a run that needs the missing face fails closed with a named code. The Team runtime faces are optional for the same reason — M1's ledger, routes and member brief keep working without them. */
export const inject = ['systemPrompt', 'typertGateway', 'webServer']

/** Plugin row shape. */
export type ConfigInput = {
  /** Master switch: when off, no routes and no prompt section are registered. */
  enabled?: boolean
}

/** Resolved plugin configuration. */
export interface Config {
  enabled: boolean
}

/** Schema of the row; the loader validates a profile patch against it. */
export const Config: z<ConfigInput, Config> = z.object({
  enabled: z.boolean().default(true).description('Mount the agent squad ledger, its routes, the member-brief section, and the forked Agent Teams runtime.'),
})

/** Schema default, re-read for hand-built test contexts. */
export const DEFAULT_ENABLED = true

/** The directory the ledger and its owner lock live in. */
export { agentsHomeDirectory }

/** System-prompt context name that carries the squad roster and goal to a Lead. */
export const SQUAD_CONTEXT_NAME = 'team:squad'

/** The system-prompt registry face the squad context needs. */
export interface SquadContextRegistry {
  /** Register one ordered dynamic context; the returned function disposes it. */
  context(context: {
    name: string
    order: number
    required?: boolean
    text: (context: never) => string
  }): () => void
  /** The host's own placement for a named context, when it publishes one. */
  getContextOrder?(name: 'TEAM_IDENTITY'): number
}

/** The system-prompt registry face, narrowed to the one method this plugin calls. */
function resolveSystemPrompt(ctx: Context): MemberPromptRegistry | undefined {
  return (ctx as { systemPrompt?: MemberPromptRegistry }).systemPrompt
}

/**
 * Read the optional workspace registry. The Host serves it as a cordis service;
 * a capture-only test context or a stripped deployment simply has none.
 */
export function resolveWorkspaceRegistry(ctx: Context): WorkspaceRegistryFace | undefined {
  try {
    const registry = (ctx as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as WorkspaceRegistryFace | undefined
    return registry !== undefined && typeof registry.list === 'function' ? registry : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the optional command dispatcher, which is how a permission pin reaches a
 * session (the same path the task board's runner uses).
 */
export function resolveCommandDispatcher(ctx: Context): CommandDispatcherFace | undefined {
  try {
    const commands = (ctx as { commands?: CommandDispatcherFace }).commands
    return commands !== undefined && typeof commands.execute === 'function' ? commands : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the optional live-agent registry; a permission pin needs the session's
 * live Agent to dispatch `/permission`.
 */
export function resolveAgents(ctx: Context): { get(sessionId: string): Agent | undefined } | undefined {
  try {
    const agents = (ctx as { agents?: { get?: unknown } }).agents
    return agents !== undefined && typeof agents.get === 'function' ? agents as { get(sessionId: string): Agent | undefined } : undefined
  } catch {
    return undefined
  }
}

/** Read the injected typert gateway (the Host's own service call surface). */
function resolveTypertGateway(ctx: Context): TypertGatewayFace | undefined {
  return (ctx as { typertGateway?: TypertGatewayFace }).typertGateway
}

/**
 * Whether this deployment serves every face the forked Agent Teams runtime
 * needs. TeamService declares them as its own inject list; a deployment missing
 * one keeps M1's ledger, routes and member brief and loses only the team runtime.
 */
export function servesTeamRuntime(ctx: Context): boolean {
  const surface = ctx as unknown as {
    agents?: { get?: unknown; list?: unknown }
    sessions?: { get?: unknown; flush?: unknown }
    sessionPersistence?: unknown
    sessionProjections?: { register?: unknown; stateOf?: unknown }
    subagents?: { startActivation?: unknown; drainChildren?: unknown }
  }
  return typeof surface.agents?.get === 'function'
    && typeof surface.agents?.list === 'function'
    && typeof surface.sessions?.get === 'function'
    && typeof surface.sessions?.flush === 'function'
    && surface.sessionPersistence !== undefined
    && typeof surface.sessionProjections?.register === 'function'
    && typeof surface.sessionProjections?.stateOf === 'function'
    && typeof surface.subagents?.startActivation === 'function'
}

/**
 * Register the `team:squad` context with the host system-prompt registry.
 *
 * A CONTEXT, not a section: a member preset that registers a `complete` section
 * restores itself as the only section, which drops every untagged section
 * (docs/member-prompt.md). Contexts are rendered beside the sections, so the
 * Lead's roster survives any preset composition.
 * @param registry - `ctx.systemPrompt`.
 * @param readText - reads the squad roster and goal for one assembling session.
 * @returns the exact disposer the registry returned.
 */
export function registerSquadPromptContext(
  registry: SquadContextRegistry,
  readText: (sessionId: string | undefined) => string,
): () => void {
  const identityOrder = typeof registry.getContextOrder === 'function' ? registry.getContextOrder('TEAM_IDENTITY') : 0
  return registry.context({
    name: SQUAD_CONTEXT_NAME,
    order: Number.isFinite(identityOrder) ? identityOrder : 0,
    required: true,
    text: (context: never) => readText(assembleIdentity(context).sessionId),
  })
}

function warn(ctx: Context, message: string, error?: unknown): void {
  const logger = (ctx as { logger?: { warn?: (...args: unknown[]) => void } }).logger
  if (typeof logger?.warn === 'function') logger.warn(message, error)
  else console.warn(message, error)
}

/**
 * Activate the host half.
 * @param ctx - the plugin context (systemPrompt, typertGateway and webServer injected).
 * @param config - resolved row config.
 */
export function apply(ctx: Context, config?: Config): void {
  if ((config?.enabled ?? DEFAULT_ENABLED) !== true) return
  const abort = new AbortController()
  const workspaces = resolveWorkspaceRegistry(ctx)
  const gateway = createHostRunGateway({
    ...(resolveTypertGateway(ctx) === undefined ? {} : { gateway: resolveTypertGateway(ctx) }),
    ...(resolveCommandDispatcher(ctx) === undefined ? {} : { commands: resolveCommandDispatcher(ctx) }),
    ...(workspaces === undefined ? {} : { workspaces }),
    ...(resolveAgents(ctx) === undefined ? {} : { agents: resolveAgents(ctx) }),
    signal: abort.signal,
  })
  // Published once the forked runtime has installed it; a squad run recorded
  // after its Lead session existed asks it to re-scan for that session.
  let teamTools: TeamToolInstallation | undefined
  const service = new AgentsHostService({
    dir: agentsHomeDirectory(),
    gateway,
    ...(workspaces === undefined ? {} : { workspaces }),
    onSquadRun: () => { teamTools?.refresh() },
  })

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      // A ledger this process cannot own or read still mounts: the routes answer
      // with the named failure instead of the panel finding no host at all, and
      // nothing on disk is touched.
      try {
        void service.state
      } catch (error) {
        warn(ctx, '[dsh-agents] the squad ledger is unusable; every route answers with its named failure and the file is left untouched', error)
      }
      for (const route of makeAgentsRoutes(service)) disposers.push(ctx.webServer.register(route))
      const systemPrompt = resolveSystemPrompt(ctx)
      if (systemPrompt !== undefined) {
        // The section reads the ledger AT ASSEMBLE TIME, so a definition edited
        // between turns is the one the next turn's prompt carries.
        disposers.push(registerMemberPromptSeam(systemPrompt, () => service.promptView()))
        const squadRegistry = systemPrompt as unknown as SquadContextRegistry
        if (typeof squadRegistry.context === 'function') {
          disposers.push(registerSquadPromptContext(squadRegistry, sessionId => service.squadContext(sessionId)))
        } else {
          warn(ctx, '[dsh-agents] this deployment serves no systemPrompt.context; a squad Lead stays unaware of its roster')
        }
      } else {
        warn(ctx, '[dsh-agents] this deployment serves no systemPrompt service; member briefs and the squad context stay un-injected')
      }

      if (!servesTeamRuntime(ctx)) {
        warn(ctx, '[dsh-agents] this deployment does not serve the agents/sessions/sessionPersistence/sessionProjections/subagents set; the forked Agent Teams runtime stays unmounted and only member runs are available')
      } else {
        // TeamService registers itself as ctx.agentTeams and registers the
        // 'agentTeam' projection on the ROOT context in its constructor, exactly
        // once per mount; the mounting context owns its lifetime.
        void new TeamService(ctx, {}, { pins: createTeammatePins(gateway) })
        // Installed only into sessions this Host launched as a squad run: the
        // forked runtime answers { role: 'lead' } for any root Session, so
        // membership alone would put the Team tools into everyday chat. The cast
        // states the service the constructor just published.
        teamTools = installTeamTools(ctx as unknown as TeamServiceContext, {
          isTeamSession: agent => service.isSquadSession(agent.id, agent.session.header.parentSession),
        })
        disposers.push(() => teamTools?.dispose())
        // A live Agent that already qualifies (a deployment that re-executes the
        // row) gets its tools now rather than at the next creation edge.
        teamTools.refresh()
      }
    } catch (error) {
      for (const dispose of disposers.splice(0)) dispose()
      service.dispose()
      throw error
    }
    return () => {
      abort.abort()
      for (const dispose of disposers.splice(0)) dispose()
      teamTools = undefined
      service.dispose()
    }
  }, 'dsh-agents: host ledger, routes, member brief, squad context, and team runtime')
}

/** Workspace registry type re-exported for the client half's own typings. */
export type { Workspace, WorkspaceRegistryFace }
