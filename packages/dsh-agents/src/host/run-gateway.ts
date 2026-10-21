/**
 * The definition/run seam.
 *
 * M1 launches ONE member session per run. Everything that touches the DSH host
 * — the agent-preset registry, session creation, the title, the pinned
 * permission/model, the first message — sits behind {@link MemberRunGateway}, so
 * the squad service owns definitions and launch ordering while M2 can fork the
 * official agent-team service behind this same interface without touching the
 * ledger or the routes.
 *
 * @module @linxin666/dsh-agents/host/run-gateway
 */
import type { InvokeRemoteRequest } from '@deepseek-ai/dsh-api-gateway'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelRoute } from '../core/model-pin.ts'
import type { AgentsPermission } from '../protocol.ts'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'

/** One agent preset as the host registry reports it. */
export interface PresetInfo {
  id: string
  /** Present when the host reports the preset unusable, carrying its reason. */
  broken?: string
}

/** What the host needs to compose one member session. */
export interface CreateSessionInput {
  /** Pinned, validated workspace; the Host never guesses one. */
  workspaceId: string
  /** Pinned agent preset, absent when the member pins none. */
  agentPreset?: string
}

/** One queued first user message. */
export interface SessionPromptInput {
  sessionId: string
  text: string
}

/** The host face a member run drives. */
export interface MemberRunGateway {
  /**
   * Read the host agent-preset registry.
   * @returns the presets, or undefined when this deployment serves no registry.
   */
  listPresets(): Promise<readonly PresetInfo[] | undefined>
  /**
   * Create one session.
   * @throws AgentsError `session-create-failed` when the host refuses.
   */
  createSession(input: CreateSessionInput): Promise<{ sessionId: string }>
  /** Rename the session to the member title. */
  renameSession(sessionId: string, title: string): Promise<void>
  /** Apply the pinned permission through the host command dispatcher. */
  applyPermission(sessionId: string, permission: AgentsPermission): Promise<void>
  /** Select the pinned model route, with the reasoning effort pinned beside it. */
  selectModel(sessionId: string, route: ModelRoute, reasoningEffort: string | undefined): Promise<void>
  /** Queue the first user message. */
  prompt(input: SessionPromptInput): Promise<void>
}

/** The workspace registry face the run gate validates against. */
export interface WorkspaceRegistryFace {
  list(): readonly Workspace[]
}

/** The command dispatcher face the permission pin drives. */
export interface CommandDispatcherFace {
  execute(agent: Agent, line: string, args: readonly string[], signal?: AbortSignal): Promise<{ kind: string; text?: string } | undefined>
}

/** The gateway peer shape; derived from the public request type. */
type GatewayPeer = InvokeRemoteRequest['peer']

/** The invoke face of `ctx.typertGateway`, narrowed to what this package calls. */
export interface TypertGatewayFace {
  invoke(request: { namespace: string; method: string; args: Record<string, unknown>; peer: GatewayPeer; signal?: AbortSignal }): Promise<unknown>
}

/** The host services a run gateway drives; all optional so a deployment can lack any. */
export interface HostRunFaces {
  gateway?: TypertGatewayFace
  commands?: CommandDispatcherFace
  workspaces?: WorkspaceRegistryFace
  agents?: { get(sessionId: string): Agent | undefined }
  /** Aborts every in-flight call when the plugin fiber disposes. */
  signal?: AbortSignal
}

/**
 * Args shape per endpoint: `agentPresets/list` declares no parameters, so its
 * args must be `{}`; every other call this package makes wraps its payload in
 * `request`.
 */
function wireArgs(namespace: string, method: string, request: Record<string, unknown>): Record<string, unknown> {
  return namespace === 'agentPresets' && method === 'list' ? {} : { request }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the production gateway over the host's own services.
 *
 * Session composition speaks for the local owner: this is the Host creating a
 * session on behalf of the user driving it, exactly the position the task
 * board's runner claims, and no wire field can set a principal.
 * @param faces - the resolved host services.
 * @returns the gateway the squad service runs members through.
 */
export function createHostRunGateway(faces: HostRunFaces): MemberRunGateway {
  const call = async (namespace: string, method: string, request: Record<string, unknown>): Promise<unknown> => {
    const gateway = faces.gateway
    if (gateway === undefined) throw new Error('the host typert gateway is unavailable')
    return await gateway.invoke({
      namespace,
      method,
      args: wireArgs(namespace, method, request),
      peer: ownerPeer(faces.signal),
      ...(faces.signal === undefined ? {} : { signal: faces.signal }),
    })
  }
  return {
    async listPresets() {
      if (faces.gateway === undefined) return undefined
      try {
        const value = await call('agentPresets', 'list', {}) as { presets?: readonly { id?: unknown; broken?: unknown }[] } | null
        if (value === null || !Array.isArray(value.presets)) return undefined
        return value.presets.flatMap((preset) => {
          if (typeof preset?.id !== 'string' || preset.id === '') return []
          return [{ id: preset.id, ...(typeof preset.broken === 'string' ? { broken: preset.broken } : {}) }]
        })
      } catch {
        // A deployment without the preset registry answers with an unmatched
        // namespace; that is "no registry", not "unknown preset".
        return undefined
      }
    },
    async createSession(input) {
      const created = await call('session', 'create', {
        workspaceId: input.workspaceId,
        ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
      }) as { sessionId?: unknown }
      if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
        throw new Error('the host returned no session id')
      }
      return { sessionId: created.sessionId }
    },
    async renameSession(sessionId, title) {
      await call('session', 'rename', { sessionId, title })
    },
    async applyPermission(sessionId, permission) {
      const commands = faces.commands
      if (commands === undefined) throw new Error('the host command dispatcher is unavailable')
      const agent = faces.agents?.get(sessionId)
      if (agent === undefined) throw new Error('session ' + sessionId + ' has no live agent')
      const result = await commands.execute(agent, '/permission ' + permission, [], AbortSignal.timeout(30_000))
      if (result === undefined) throw new Error('the permission command was not acknowledged')
      if (result.kind !== 'success') throw new Error(result.text ?? 'the permission command failed')
    },
    async selectModel(sessionId, route, reasoningEffort) {
      await call('session', 'selectModel', {
        sessionId,
        ...(route.provider === undefined ? {} : { provider: route.provider }),
        model: route.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
    },
    async prompt(input) {
      await call('session', 'prompt', {
        sessionId: input.sessionId,
        requestId: 'dsh-agents-' + crypto.randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: input.text }],
      })
    },
  }
}

/**
 * The in-process owner peer these calls speak for. Interaction level is
 * `none`: this package only invokes methods and never receives forwarded events.
 * @param signal - the plugin fiber's abort signal, when there is one.
 */
function ownerPeer(signal?: AbortSignal): GatewayPeer {
  return {
    id: ('dsh-agents-owner:' + crypto.randomUUID()) as GatewayPeer['id'],
    principal: { kind: 'owner' },
    ...(signal === undefined ? {} : { signal }),
    interactions: 'none',
    dispose: () => Promise.resolve(),
  } as GatewayPeer
}
