/**
 * Host entry of the dsh-agents plugin: one ledger, the six squad routes, and the
 * member-brief system-prompt section.
 *
 * This file wires faces the Host already serves; every rule it depends on lives
 * beside it — the ledger in host/ledger.ts, the definition/run seam in
 * host/run-gateway.ts, the launch order in host/service.ts, the fence and the
 * wire in host/routes.ts and protocol.ts, and the injection decision in
 * host/member-prompt.ts (evidence in docs/member-prompt.md).
 *
 * @module @linxin666/dsh-agents
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { agentsHomeDirectory } from './host/home.ts'
import { registerMemberPromptSeam, type MemberPromptRegistry } from './host/member-prompt.ts'
import { makeAgentsRoutes } from './host/routes.ts'
import { createHostRunGateway, type CommandDispatcherFace, type TypertGatewayFace, type WorkspaceRegistryFace } from './host/run-gateway.ts'
import { AgentsHostService } from './host/service.ts'

/** Services this row needs before it mounts. The workspace registry, command dispatcher and agent registry are resolved optionally: a deployment that lacks one still mounts, and a run that needs the missing face fails closed with a named code. */
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
  enabled: z.boolean().default(true).description('Mount the agent squad ledger, its routes, and the member-brief system-prompt section.'),
})

/** Schema default, re-read for hand-built test contexts. */
export const DEFAULT_ENABLED = true

/** The directory the ledger and its owner lock live in. */
export { agentsHomeDirectory }

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
  const service = new AgentsHostService({
    dir: agentsHomeDirectory(),
    gateway: createHostRunGateway({
      ...(resolveTypertGateway(ctx) === undefined ? {} : { gateway: resolveTypertGateway(ctx) }),
      ...(resolveCommandDispatcher(ctx) === undefined ? {} : { commands: resolveCommandDispatcher(ctx) }),
      ...(resolveWorkspaceRegistry(ctx) === undefined ? {} : { workspaces: resolveWorkspaceRegistry(ctx) }),
      ...(resolveAgents(ctx) === undefined ? {} : { agents: resolveAgents(ctx) }),
      signal: abort.signal,
    }),
    ...(resolveWorkspaceRegistry(ctx) === undefined ? {} : { workspaces: resolveWorkspaceRegistry(ctx) }),
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
      } else {
        warn(ctx, '[dsh-agents] this deployment serves no systemPrompt service; member briefs stay un-injected')
      }
    } catch (error) {
      for (const dispose of disposers.splice(0)) dispose()
      service.dispose()
      throw error
    }
    return () => {
      abort.abort()
      for (const dispose of disposers.splice(0)) dispose()
      service.dispose()
    }
  }, 'dsh-agents: host ledger, routes, and member brief')
}

/** Workspace registry type re-exported for the client half's own typings. */
export type { Workspace, WorkspaceRegistryFace }
