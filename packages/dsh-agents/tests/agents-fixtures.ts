/**
 * Fixtures and the fake transport shared by the agents client suites.
 *
 * The page talks to the transport interface only, so a suite injects this fake
 * instead of patching `fetch` or spying on a module: reads and runs are
 * counted on the fake, and every answer is the frozen wire shape.
 */
import type { AgentsTransport } from '../src/client/host-api.ts'
import type { AgentsStateView, MemberDefinition, MemberDraft, RunRecord, TeamDefinition, TeamDraft } from '../src/protocol.ts'

/** One squad with no members unless overridden. */
export function teamOf(overrides: Partial<TeamDefinition> = {}): TeamDefinition {
  return {
    id: 'team-1',
    name: 'Squad one',
    description: 'Two reviewers and one builder',
    workspaceId: 'workspace-main',
    createdAt: 0,
    updatedAt: 0,
    members: [],
    ...overrides,
  }
}

/** One member with every optional field pinned unless overridden. */
export function memberOf(overrides: Partial<MemberDefinition> = {}): MemberDefinition {
  return {
    id: 'member-1',
    teamId: 'team-1',
    name: 'Reviewer',
    preset: 'standard',
    permission: 'read-only',
    model: 'deepseek/deepseek-v4',
    brief: 'Reviews the diff and names the risky parts before the build runs',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

/** One run of a member. */
export function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    teamId: 'team-1',
    memberId: 'member-1',
    sessionId: 'session-1',
    createdAt: 0,
    status: 'running',
    ...overrides,
  }
}

/** One published state. */
export function stateOf(teams: TeamDefinition[], runs: RunRecord[] = []): AgentsStateView {
  return { teams, runs, host: { ownerPid: 4242 } }
}

/** The fake's configuration; every hook is optional except the read. */
export interface FakeTransportConfig {
  state: (read: number) => Promise<AgentsStateView>
  run?: (teamId: string, memberId: string) => Promise<RunRecord>
  createTeam?: (draft: TeamDraft) => Promise<TeamDefinition>
  deleteTeam?: (teamId: string) => Promise<void>
  saveMember?: (teamId: string, member: MemberDraft) => Promise<TeamDefinition>
  deleteMember?: (teamId: string, memberId: string) => Promise<TeamDefinition>
}

/** The injected fake plus the counters the poll suite reads. */
export interface FakeTransport extends AgentsTransport {
  readonly reads: number
  readonly runs: number
}

/**
 * Build the fake transport the page drives.
 * @param config - answers per contract route.
 */
export function fakeTransport(config: FakeTransportConfig): FakeTransport {
  let reads = 0
  let runs = 0
  const missing = (route: string): never => { throw new Error(route + ' is not configured in this fake') }
  return {
    get reads(): number { return reads },
    get runs(): number { return runs },
    async state(_signal?: AbortSignal): Promise<AgentsStateView> {
      reads += 1
      return config.state(reads)
    },
    async run(teamId: string, memberId: string): Promise<RunRecord> {
      runs += 1
      return config.run === undefined ? missing('run') : config.run(teamId, memberId)
    },
    async createTeam(draft: TeamDraft): Promise<TeamDefinition> {
      return config.createTeam === undefined ? missing('createTeam') : config.createTeam(draft)
    },
    async deleteTeam(teamId: string): Promise<void> {
      return config.deleteTeam === undefined ? missing('deleteTeam') : config.deleteTeam(teamId)
    },
    async saveMember(teamId: string, member: MemberDraft): Promise<TeamDefinition> {
      return config.saveMember === undefined ? missing('saveMember') : config.saveMember(teamId, member)
    },
    async deleteMember(teamId: string, memberId: string): Promise<TeamDefinition> {
      return config.deleteMember === undefined ? missing('deleteMember') : config.deleteMember(teamId, memberId)
    },
  }
}
