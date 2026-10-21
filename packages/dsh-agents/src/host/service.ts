/**
 * The squad service: CRUD over team/member definitions plus the single-member
 * run, over the one Host ledger.
 *
 * Two invariants own this file:
 * - Definitions are the ledger's. Ids are minted here, timestamps are stamped
 *   here, and a draft never reaches disk unchecked.
 * - A run fails closed BEFORE a session exists whenever its definition cannot be
 *   honoured (unusable model pin, unknown preset, missing or unknown workspace),
 *   and every failure AFTER a session exists is recorded on a run record, so no
 *   session this plugin created can be invisible to the user.
 *
 * @module @linxin666/dsh-agents/host/service
 */
import { join } from 'node:path'
import { AgentsError, isAgentsError } from '../core/errors.ts'
import { applyMemberDraft, applyTeamDraft, createMember, createTeam, findMember, findTeam, sortTeams, touchTeam } from '../core/definition.ts'
import { parseModelPin } from '../core/model-pin.ts'
import { AgentsLedger, AGENTS_LEDGER_FILE, AGENTS_LEDGER_LOCK_FILE, RUN_HISTORY_LIMIT, type AgentsLedgerData } from './ledger.ts'
import { agentsHomeDirectory } from './home.ts'
import type { MemberRunGateway, WorkspaceRegistryFace } from './run-gateway.ts'
import type {
  AgentsStateView,
  MemberDefinition,
  MemberDraft,
  RunRecord,
  RunRequestBody,
  TeamDefinition,
  TeamDraft,
} from '../protocol.ts'

/** Construction options. */
export interface AgentsHostServiceOptions {
  /** Plugin-owned directory; defaults to `$DSH_HOME/dsh-agents`. */
  dir?: string
  /** The host run gateway. */
  gateway: MemberRunGateway
  /** The host workspace registry, when this deployment serves one. */
  workspaces?: WorkspaceRegistryFace
  /** Clock seam. */
  now?: () => number
  /** Id minting seam. */
  idFactory?: () => string
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The Host service behind the routes and the member-brief section.
 *
 * A corrupt or foreign-owned ledger is not an exception the caller has to
 * unwrap: the service keeps the failure and refuses every operation with it, so
 * the browser receives `ledger-corrupt` and the bytes on disk stay untouched.
 */
export class AgentsHostService {
  private readonly gateway: MemberRunGateway
  private readonly workspaces: WorkspaceRegistryFace | undefined
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly directory: string
  private readonly ledger: AgentsLedger | undefined
  private readonly failure: Error | undefined

  constructor(options: AgentsHostServiceOptions) {
    this.gateway = options.gateway
    this.workspaces = options.workspaces
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID())
    this.directory = options.dir ?? agentsHomeDirectory()
    try {
      this.ledger = AgentsLedger.open({ dir: this.directory, now: this.now })
    } catch (error) {
      this.ledger = undefined
      this.failure = isAgentsError(error) ? error : new AgentsError('ledger-corrupt', describe(error))
    }
  }

  /** Absolute path of the ledger document this service owns. */
  get ledgerFile(): string {
    return this.ledger?.file ?? join(this.directory, AGENTS_LEDGER_FILE)
  }

  /** Absolute path of the owner lock. */
  get lockFile(): string {
    return this.ledger?.lockFile ?? join(this.directory, AGENTS_LEDGER_LOCK_FILE)
  }

  /** Pid that owns the ledger, or this process when the ledger never opened. */
  get ownerPid(): number {
    return this.ledger?.ownerPid ?? process.pid
  }

  /**
   * The ledger snapshot the browser panel renders.
   * @returns teams in served order, runs newest first, and the owning pid.
   */
  get state(): AgentsStateView {
    const data = this.requireLedger().snapshot()
    return { teams: sortTeams(data.teams), runs: data.runs, host: { ownerPid: this.ownerPid } }
  }

  /**
   * The definition view the member-brief section reads at assemble time.
   * @returns the raw ledger snapshot, or an empty view while the ledger is
   *   unusable — an unreadable ledger must not fail a user's ordinary turn.
   */
  promptView(): AgentsLedgerData {
    if (this.ledger === undefined) return { teams: [], runs: [] }
    return this.ledger.snapshot()
  }

  /**
   * Create a team, or replace the editable fields of the one its draft names.
   * @param draft - validated draft.
   * @returns the created or replaced team.
   */
  saveTeam(draft: TeamDraft): TeamDefinition {
    const ledger = this.requireLedger()
    if (draft.id === undefined) {
      const team = createTeam(draft, this.now(), this.idFactory())
      ledger.mutate((document) => { document.teams.push(team) })
      return team
    }
    const teamId = draft.id
    const current = findTeam(ledger.snapshot().teams, teamId)
    if (current === undefined) throw new AgentsError('team-not-found', 'no team has the id "' + teamId + '"')
    const next = applyTeamDraft(current, draft, this.now())
    ledger.mutate((document) => {
      document.teams = document.teams.map(candidate => candidate.id === teamId ? next : candidate)
    })
    return next
  }

  /**
   * Delete a team with every member definition it holds. Run records stay: they
   * are the history of sessions this Host opened, not part of the definition.
   * @param teamId - the team to delete.
   */
  deleteTeam(teamId: string): void {
    const ledger = this.requireLedger()
    if (findTeam(ledger.snapshot().teams, teamId) === undefined) {
      throw new AgentsError('team-not-found', 'no team has the id "' + teamId + '"')
    }
    ledger.mutate((document) => {
      document.teams = document.teams.filter(candidate => candidate.id !== teamId)
    })
  }

  /**
   * Create a member in a team, or replace the editable fields of the member its
   * draft names. The request's teamId and the draft's id must both resolve inside
   * that one team, so an edit can never move a member to another squad.
   * @param teamId - the team the member belongs to.
   * @param draft - validated draft.
   * @returns the team after the change.
   */
  saveMember(teamId: string, draft: MemberDraft): TeamDefinition {
    const ledger = this.requireLedger()
    const team = findTeam(ledger.snapshot().teams, teamId)
    if (team === undefined) throw new AgentsError('team-not-found', 'no team has the id "' + teamId + '"')
    const now = this.now()
    let next: TeamDefinition
    if (draft.id === undefined) {
      const member = createMember(draft, teamId, now, this.idFactory())
      next = touchTeam({ ...team, members: [...team.members, member] }, now)
    } else {
      const memberId = draft.id
      const current = findMember(team, memberId)
      if (current === undefined) {
        throw new AgentsError('member-not-found', 'no member has the id "' + memberId + '" in team "' + teamId + '"')
      }
      const replaced = applyMemberDraft(current, draft, now)
      next = touchTeam({ ...team, members: team.members.map(candidate => candidate.id === memberId ? replaced : candidate) }, now)
    }
    ledger.mutate((document) => {
      document.teams = document.teams.map(candidate => candidate.id === teamId ? next : candidate)
    })
    return next
  }

  /**
   * Delete one member definition.
   * @param teamId - the team the member belongs to.
   * @param memberId - the member to delete.
   * @returns the team after the change.
   */
  deleteMember(teamId: string, memberId: string): TeamDefinition {
    const ledger = this.requireLedger()
    const team = findTeam(ledger.snapshot().teams, teamId)
    if (team === undefined) throw new AgentsError('team-not-found', 'no team has the id "' + teamId + '"')
    if (findMember(team, memberId) === undefined) {
      throw new AgentsError('member-not-found', 'no member has the id "' + memberId + '" in team "' + teamId + '"')
    }
    const now = this.now()
    const next = touchTeam({ ...team, members: team.members.filter(candidate => candidate.id !== memberId) }, now)
    ledger.mutate((document) => {
      document.teams = document.teams.map(candidate => candidate.id === teamId ? next : candidate)
    })
    return next
  }

  /**
   * Launch one member session.
   *
   * Order is the contract: every definition check happens before a session
   * exists, so a rejected run costs no quota; once the session exists, any later
   * failure is recorded on the run and rethrown as a named error.
   * @param request - the validated run body.
   * @returns the run record of the launched session.
   */
  async run(request: RunRequestBody): Promise<RunRecord> {
    const ledger = this.requireLedger()
    const data = ledger.snapshot()
    const team = findTeam(data.teams, request.teamId)
    if (team === undefined) throw new AgentsError('team-not-found', 'no team has the id "' + request.teamId + '"')
    const member = findMember(team, request.memberId)
    if (member === undefined) {
      throw new AgentsError('member-not-found', 'no member has the id "' + request.memberId + '" in team "' + request.teamId + '"')
    }

    // The Host never guesses a workspace: an unpinned team is refused rather than
    // landing the session in whatever directory the Host process happens to run in.
    const workspaceId = team.workspaceId
    if (workspaceId === undefined) {
      throw new AgentsError('workspace-required', 'team "' + team.name + '" pins no workspace; set one before running a member')
    }
    if (this.workspaces === undefined) {
      throw new AgentsError('workspace-unavailable', 'this deployment serves no workspace registry, so the pinned workspace cannot be validated')
    }
    if (!this.workspaces.list().some(workspace => workspace.id === workspaceId)) {
      throw new AgentsError('workspace-unknown', 'the host workspace registry has no workspace "' + workspaceId + '"')
    }

    // A pin the Host cannot honour is refused before any session exists; a
    // half-parsed route would otherwise select a model the user never chose.
    const route = parseModelPin(member.model)
    if (member.model !== undefined && route === undefined) {
      throw new AgentsError('model-pin-invalid', 'member "' + member.name + '" pins the model "' + member.model + '" which is not a usable route')
    }
    const agentPreset = await this.resolvePreset(member)

    let sessionId: string
    try {
      sessionId = (await this.gateway.createSession({ workspaceId, ...(agentPreset === undefined ? {} : { agentPreset }) })).sessionId
    } catch (error) {
      throw new AgentsError('session-create-failed', 'the host refused to create the member session: ' + describe(error))
    }

    const title = team.name + ' / ' + member.name
    try {
      await this.gateway.renameSession(sessionId, title)
    } catch (error) {
      throw this.failRun(team, member, sessionId, 'session-rename-failed', 'the session could not be renamed to "' + title + '": ' + describe(error))
    }
    try {
      if (member.permission !== undefined) await this.gateway.applyPermission(sessionId, member.permission)
      if (route !== undefined) await this.gateway.selectModel(sessionId, route, member.reasoningEffort)
    } catch (error) {
      throw this.failRun(team, member, sessionId, 'session-pin-failed', 'the session refused the pinned permission or model: ' + describe(error))
    }
    if (request.firstMessage !== undefined) {
      try {
        await this.gateway.prompt({ sessionId, text: request.firstMessage })
      } catch (error) {
        throw this.failRun(team, member, sessionId, 'session-prompt-failed', 'the first message could not be queued: ' + describe(error))
      }
    }
    return this.recordRun(team, member, sessionId, 'running')
  }

  /** Release the owner lock. Idempotent. */
  dispose(): void {
    this.ledger?.dispose()
  }

  /**
   * Resolve the member's pinned agent preset against the host registry.
   * @returns the preset id to compose the session from, or undefined when the
   *   member pins none (the deployment default then composes the session).
   * @throws AgentsError `preset-registry-unavailable`, `preset-unknown` or
   *   `preset-unavailable`.
   */
  private async resolvePreset(member: MemberDefinition): Promise<string | undefined> {
    if (member.preset === undefined) return undefined
    const presets = await this.gateway.listPresets()
    if (presets === undefined) {
      throw new AgentsError('preset-registry-unavailable', 'this deployment serves no host agent-preset registry, so preset "' + member.preset + '" cannot be resolved')
    }
    const preset = presets.find(candidate => candidate.id === member.preset)
    if (preset === undefined) {
      throw new AgentsError('preset-unknown', 'the host agent-preset registry has no preset "' + member.preset + '"')
    }
    if (preset.broken !== undefined) {
      throw new AgentsError('preset-unavailable', 'the host agent-preset registry reports preset "' + preset.id + '" unusable: ' + preset.broken)
    }
    return preset.id
  }

  /**
   * Append a failed run record for a session that exists, and return the error to
   * throw. A session this Host opened is never left without its record.
   */
  private failRun(team: TeamDefinition, member: MemberDefinition, sessionId: string, code: 'session-rename-failed' | 'session-pin-failed' | 'session-prompt-failed', message: string): AgentsError {
    this.recordRun(team, member, sessionId, 'failed', message)
    return new AgentsError(code, message)
  }

  private recordRun(team: TeamDefinition, member: MemberDefinition, sessionId: string, status: RunRecord['status'], failure?: string): RunRecord {
    const run: RunRecord = {
      id: this.idFactory(),
      teamId: team.id,
      memberId: member.id,
      sessionId,
      createdAt: this.now(),
      status,
      ...(failure === undefined ? {} : { failure }),
    }
    this.requireLedger().mutate((document) => {
      document.runs = [run, ...document.runs].slice(0, RUN_HISTORY_LIMIT)
    })
    return run
  }

  private requireLedger(): AgentsLedger {
    if (this.ledger !== undefined) return this.ledger
    const failure = this.failure
    if (failure instanceof AgentsError) throw failure
    throw new AgentsError('ledger-corrupt', failure === undefined ? 'the dsh-agents ledger is unavailable' : describe(failure))
  }
}
