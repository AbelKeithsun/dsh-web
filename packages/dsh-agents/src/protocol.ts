/**
 * Frozen wire contract of the dsh-agents plugin.
 *
 * Owns the API prefix, the six route shapes, and the ledger record types the
 * Host serves and the browser imports. This file is the single source of the
 * contract: the client half type-imports these declarations and never restates
 * them, and no route outside the list below may be registered.
 *
 * M1 scope: definitions (teams and their members) and single-member runs.
 * Whole-squad runs are M2 and will reach this contract as new routes, not as a
 * reinterpretation of these.
 *
 * @module @linxin666/dsh-agents/protocol
 */

/**
 * Root-absolute Host prefix. The browser half drops the leading slash, exactly
 * like the task board's `TASK_BOARD_API_PREFIX`.
 */
export const DSH_AGENTS_API_PREFIX = '/dsh-agents/api'

/** Ledger document generation this build reads and writes. */
export const DSH_AGENTS_SCHEMA_VERSION = 1 as const

/** Sandbox modes a member may pin; the DSH permission presets, verbatim. */
export const AGENTS_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One DSH permission preset a member may pin. */
export type AgentsPermission = (typeof AGENTS_PERMISSIONS)[number]

/** Longest accepted team or member display name. */
export const NAME_MAX_LENGTH = 120

/** Longest accepted team description. */
export const DESCRIPTION_MAX_LENGTH = 2_000

/** Longest accepted member-level brief (it lands in the system prompt). */
export const BRIEF_MAX_LENGTH = 4_000

/** Longest accepted pinned target (preset id, model route, effort id, workspace id). */
export const PIN_MAX_LENGTH = 200

/** Longest accepted definition id on the wire. */
export const ID_MAX_LENGTH = 128

/** Longest accepted first user message on a run request. */
export const FIRST_MESSAGE_MAX_LENGTH = 32_000

/**
 * Stable machine codes every error reply carries. The browser switches on this
 * value; the human-readable `error` text beside it is not a contract and never
 * carries a stack trace.
 */
export const AGENTS_ERROR_CODES = [
  /** The request body is not a well-formed message of the addressed route. */
  'invalid-request',
  /** The body exceeded the route's byte cap. */
  'body-too-large',
  /** The route requires a JSON body and the caller sent something else. */
  'json-required',
  /** The method is not the one this route serves. */
  'method-not-allowed',
  /** The request did not arrive from this machine's own browser. */
  'forbidden',
  /** No team has that id. */
  'team-not-found',
  /** No member with that id exists in the addressed team. */
  'member-not-found',
  /** The deployment serves no host agent-preset registry. */
  'preset-registry-unavailable',
  /** The pinned agent preset id is not in the host registry. */
  'preset-unknown',
  /** The pinned agent preset exists but the host reports it unusable. */
  'preset-unavailable',
  /** The team pins no workspace and this Host never guesses one. */
  'workspace-required',
  /** The deployment serves no workspace registry. */
  'workspace-unavailable',
  /** The pinned workspace id is not in the host workspace registry. */
  'workspace-unknown',
  /** The member pins a model route that cannot be split into provider and model. */
  'model-pin-invalid',
  /** The session could not be created. */
  'session-create-failed',
  /** The session was created but could not be renamed to the member title. */
  'session-rename-failed',
  /** The session was created but refused the pinned permission or model. */
  'session-pin-failed',
  /** The session was created but the first message could not be queued. */
  'session-prompt-failed',
  /** A permission pin was requested and no command dispatcher serves `/permission`. */
  'permission-dispatcher-unavailable',
  /** The ledger on disk is unreadable or corrupt; nothing was overwritten. */
  'ledger-corrupt',
  /** Another process owns the ledger. */
  'ledger-owned',
  /** The ledger could not be written. */
  'ledger-write-failed',
  /** The Host failed in a way this plugin did not anticipate. */
  'internal-error',
] as const

/** One stable machine code from {@link AGENTS_ERROR_CODES}. */
export type AgentsErrorCode = (typeof AGENTS_ERROR_CODES)[number]

/**
 * One reusable member definition: a display name, an optional DSH agent preset,
 * a permission, a model pin, a reasoning effort, and a member-level brief that
 * becomes part of that member session's system prompt.
 */
export interface MemberDefinition {
  id: string
  teamId: string
  name: string
  preset?: string
  permission?: 'read-only' | 'workspace-write' | 'danger-full-access'
  model?: string
  reasoningEffort?: string
  brief?: string
  createdAt: number
  updatedAt: number
}

/** One agent squad: an ordered set of member definitions sharing a workspace. */
export interface TeamDefinition {
  id: string
  name: string
  description?: string
  workspaceId?: string
  order?: number
  createdAt: number
  updatedAt: number
  members: MemberDefinition[]
}

/** One launched member session. */
export interface RunRecord {
  id: string
  teamId: string
  memberId: string
  sessionId: string
  createdAt: number
  status: 'running' | 'settled' | 'failed'
  failure?: string
}

/** Definition fields a caller may write; `id` addresses an existing member. */
export type MemberDraft = Omit<MemberDefinition, 'id' | 'teamId' | 'createdAt' | 'updatedAt'> & { id?: string }

/** Definition fields a caller may write; `id` addresses an existing team. */
export type TeamDraft = Omit<TeamDefinition, 'id' | 'createdAt' | 'updatedAt' | 'members'> & { id?: string }

/** `GET {DSH_AGENTS_API_PREFIX}/state`: everything the browser panel renders. */
export interface AgentsStateView {
  teams: TeamDefinition[]
  runs: RunRecord[]
  host: { ownerPid: number }
}

/** `POST {DSH_AGENTS_API_PREFIX}/team` body. */
export interface TeamRequestBody {
  team: TeamDraft
}

/** `POST {DSH_AGENTS_API_PREFIX}/team` reply. */
export interface TeamResponseBody {
  team: TeamDefinition
}

/** `POST {DSH_AGENTS_API_PREFIX}/team/delete` body. */
export interface TeamDeleteRequestBody {
  teamId: string
}

/** `POST {DSH_AGENTS_API_PREFIX}/member` body. */
export interface MemberRequestBody {
  teamId: string
  member: MemberDraft
}

/** `POST {DSH_AGENTS_API_PREFIX}/member` and `/member/delete` reply. */
export interface MemberResponseBody {
  team: TeamDefinition
}

/** `POST {DSH_AGENTS_API_PREFIX}/member/delete` body. */
export interface MemberDeleteRequestBody {
  teamId: string
  memberId: string
}

/** `POST {DSH_AGENTS_API_PREFIX}/run` body. */
export interface RunRequestBody {
  teamId: string
  memberId: string
  /** Optional first user message; the member brief never travels here. */
  firstMessage?: string
}

/** `POST {DSH_AGENTS_API_PREFIX}/run` reply. */
export interface RunResponseBody {
  run: RunRecord
}

/** `POST {DSH_AGENTS_API_PREFIX}/team/delete` reply. */
export interface OkResponseBody {
  ok: true
}

/** Every non-2xx reply: a stable code plus bounded human text, never a stack. */
export interface AgentsErrorBody {
  ok: false
  code: AgentsErrorCode
  error: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

/** Whether a value names one of the sandbox modes a member may pin. */
export function isAgentsPermission(value: unknown): value is AgentsPermission {
  return typeof value === 'string' && (AGENTS_PERMISSIONS as readonly string[]).includes(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Read an optional bounded text field, trimming it and collapsing blank to
 * absent: the ledger never stores "" for a pin the user cleared.
 * @returns the trimmed text, undefined for blank, or null when the value is not
 *   a string within the cap (the caller rejects the request).
 */
function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined
  if (!boundedString(value, max)) return null
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function definitionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= ID_MAX_LENGTH ? value.trim() : undefined
}

/**
 * Gate one member draft from the wire. Unknown fields are refused rather than
 * ignored, so a caller cannot smuggle a timestamp or an id the Host did not
 * mint into a definition.
 * @param value - decoded JSON value.
 * @returns the normalized draft, or undefined when the request is rejected.
 */
export function parseMemberDraft(value: unknown): MemberDraft | undefined {
  const draft = record(value)
  if (draft === undefined || !exactKeys(draft, ['id', 'name', 'preset', 'permission', 'model', 'reasoningEffort', 'brief'])) return undefined
  if (typeof draft.name !== 'string') return undefined
  const name = draft.name.trim()
  if (name === '' || name.length > NAME_MAX_LENGTH) return undefined
  const id = draft.id === undefined ? undefined : definitionId(draft.id)
  if (draft.id !== undefined && id === undefined) return undefined
  if (draft.permission !== undefined && !isAgentsPermission(draft.permission)) return undefined
  const preset = optionalText(draft.preset, PIN_MAX_LENGTH)
  const model = optionalText(draft.model, PIN_MAX_LENGTH)
  const reasoningEffort = optionalText(draft.reasoningEffort, PIN_MAX_LENGTH)
  const brief = optionalText(draft.brief, BRIEF_MAX_LENGTH)
  if (preset === null || model === null || reasoningEffort === null || brief === null) return undefined
  return {
    ...(id === undefined ? {} : { id }),
    name,
    ...(preset === undefined ? {} : { preset }),
    ...(draft.permission === undefined ? {} : { permission: draft.permission }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(brief === undefined ? {} : { brief }),
  }
}

/**
 * Gate one team draft from the wire. Same rules as {@link parseMemberDraft}:
 * exact keys, bounded text, and `order` only as a finite integer.
 * @param value - decoded JSON value.
 * @returns the normalized draft, or undefined when the request is rejected.
 */
export function parseTeamDraft(value: unknown): TeamDraft | undefined {
  const draft = record(value)
  if (draft === undefined || !exactKeys(draft, ['id', 'name', 'description', 'workspaceId', 'order'])) return undefined
  if (typeof draft.name !== 'string') return undefined
  const name = draft.name.trim()
  if (name === '' || name.length > NAME_MAX_LENGTH) return undefined
  const id = draft.id === undefined ? undefined : definitionId(draft.id)
  if (draft.id !== undefined && id === undefined) return undefined
  if (draft.order !== undefined && (typeof draft.order !== 'number' || !Number.isInteger(draft.order))) return undefined
  const description = optionalText(draft.description, DESCRIPTION_MAX_LENGTH)
  const workspaceId = optionalText(draft.workspaceId, PIN_MAX_LENGTH)
  if (description === null || workspaceId === null) return undefined
  return {
    ...(id === undefined ? {} : { id }),
    name,
    ...(description === undefined ? {} : { description }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(draft.order === undefined ? {} : { order: draft.order }),
  }
}

/** Gate the `POST /team` body. */
export function parseTeamRequestBody(value: unknown): TeamRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['team'])) return undefined
  const team = parseTeamDraft(body.team)
  return team === undefined ? undefined : { team }
}

/** Gate the `POST /team/delete` body. */
export function parseTeamDeleteRequestBody(value: unknown): TeamDeleteRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId'])) return undefined
  const teamId = definitionId(body.teamId)
  return teamId === undefined ? undefined : { teamId }
}

/** Gate the `POST /member` body. */
export function parseMemberRequestBody(value: unknown): MemberRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId', 'member'])) return undefined
  const teamId = definitionId(body.teamId)
  if (teamId === undefined) return undefined
  const member = parseMemberDraft(body.member)
  return member === undefined ? undefined : { teamId, member }
}

/** Gate the `POST /member/delete` body. */
export function parseMemberDeleteRequestBody(value: unknown): MemberDeleteRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId', 'memberId'])) return undefined
  const teamId = definitionId(body.teamId)
  const memberId = definitionId(body.memberId)
  return teamId === undefined || memberId === undefined ? undefined : { teamId, memberId }
}

/**
 * Gate the `POST /run` body. The first message is bounded here only; whether a
 * run prompts at all is the Host's decision (an absent message launches the
 * session without one, and the member brief never rides this field).
 */
export function parseRunRequestBody(value: unknown): RunRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId', 'memberId', 'firstMessage'])) return undefined
  const teamId = definitionId(body.teamId)
  const memberId = definitionId(body.memberId)
  if (teamId === undefined || memberId === undefined) return undefined
  if (body.firstMessage !== undefined && !boundedString(body.firstMessage, FIRST_MESSAGE_MAX_LENGTH)) return undefined
  const firstMessage = typeof body.firstMessage === 'string' && body.firstMessage.trim() !== '' ? body.firstMessage : undefined
  return { teamId, memberId, ...(firstMessage === undefined ? {} : { firstMessage }) }
}

/**
 * The exact path of every route this plugin serves. The Host registers these
 * and nothing else; a caller that wants a new operation amends this list first.
 */
export const DSH_AGENTS_ROUTE_PATHS = [
  DSH_AGENTS_API_PREFIX + '/state',
  DSH_AGENTS_API_PREFIX + '/team',
  DSH_AGENTS_API_PREFIX + '/team/delete',
  DSH_AGENTS_API_PREFIX + '/member',
  DSH_AGENTS_API_PREFIX + '/member/delete',
  DSH_AGENTS_API_PREFIX + '/run',
] as const
