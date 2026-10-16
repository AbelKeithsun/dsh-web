/**
 * Run-launch admission. One board action opens a whole subtree, so the Host
 * used to create every member's session in the same tick — the burst this
 * queue bounds. The measurement here is deterministic and independent of
 * wall-clock time: a gateway whose `session/create` blocks until the test
 * releases it, and the peak number of creations in flight.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { DEFAULT_RUN_LAUNCH_WIDTH, RUN_LAUNCH_WIDTH_MAX, normalizeRunLaunchWidth } from '../src/core/launch-width.ts'

const roots: string[] = []
const NOW = 1_700_000_000_000

type GatewayRequest = {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-launch-width-'))
  roots.push(value)
  return value
}

/**
 * Let every promise in the launch chain advance. The chain is gateway promises
 * and ledger writes only, so draining the microtask queue is deterministic and
 * needs no timer.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
}

/**
 * A gateway that holds every `session/create` until the test releases it, so
 * "how many creations are in flight at once" is an exact count rather than a
 * race. `failCreateOn` makes one ordinal fail before it is held, for the
 * failure-isolation case.
 */
function createGate(failCreateOn?: (ordinal: number) => string | undefined) {
  let calls = 0
  let created = 0
  let inFlight = 0
  let peak = 0
  const waiting: Array<() => void> = []
  const invoke = vi.fn(async (request: GatewayRequest) => {
    if (request.namespace !== 'session') throw new Error('unexpected namespace: ' + request.namespace)
    if (request.method === 'create') {
      calls += 1
      const failure = failCreateOn?.(calls)
      if (failure !== undefined) throw new Error(failure)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>(resolve => { waiting.push(resolve) })
      inFlight -= 1
      created += 1
      return { sessionId: `session-${created}` }
    }
    if (request.method === 'rename') return { title: 'x', seq: 1 }
    if (request.method === 'prompt') return { accepted: true }
    if (request.method === 'list') return { items: [] }
    throw new Error('unexpected gateway call: ' + request.method)
  })
  const stream = vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} }))
  return {
    gateway: { invoke, stream } as unknown as TypertGateway,
    releaseAll(): void { while (waiting.length > 0) waiting.shift()?.() },
    get calls(): number { return calls },
    get created(): number { return created },
    get inFlight(): number { return inFlight },
    get waiting(): number { return waiting.length },
    get peak(): number { return peak },
  }
}

type Gate = ReturnType<typeof createGate>

/** Release held creations until the Host has asked for all `total` sessions. */
async function drain(gate: Gate, total: number): Promise<void> {
  for (let round = 0; round < total * 4 + 20; round += 1) {
    if (gate.calls >= total && gate.waiting === 0 && gate.inFlight === 0) break
    gate.releaseAll()
    await settle()
  }
  if (gate.calls < total || gate.waiting > 0 || gate.inFlight > 0) {
    throw new Error(`launch admission did not drain: ${gate.calls}/${total} requested, ${gate.waiting} held, ${gate.inFlight} in flight`)
  }
}

/** One root plus `subtasks` children, seeded through the real create action. */
function seedTree(ledger: HostTaskLedger, subtasks: number): void {
  ledger.applyRequest('seed-root', {
    kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root' },
  })
  for (let index = 0; index < subtasks; index += 1) {
    const id = `member-${index}`
    ledger.applyRequest('seed-' + id, {
      kind: 'create', id, input: { title: `member ${index}`, description: '', prompt: `work ${index}`, parentId: 'root' },
    })
  }
}

function serviceFor(ledger: HostTaskLedger, gate: Gate, width: () => number): TaskBoardHostService {
  return new TaskBoardHostService(gate.gateway, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
    runLaunchWidth: width,
  })
}

/** Every task whose latest execution reached a session. */
function started(ledger: HostTaskLedger): number {
  return ledger.state().tasks.filter(task => task.executions.at(-1)?.sessionId !== undefined).length
}

function latest(ledger: HostTaskLedger, id: string) {
  return ledger.state().tasks.find(task => task.id === id)?.executions.at(-1)
}

describe('run launch admission width', () => {
  it('user running a 40-subtask card creates three sessions at once and still starts all 41', async () => {
    // Given a root with 40 subtasks and the default width
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 40)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => DEFAULT_RUN_LAUNCH_WIDTH)

    // When the user runs the root
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await settle()

    // Then only the width is in flight, not the whole tree
    expect(gate.inFlight).toBe(DEFAULT_RUN_LAUNCH_WIDTH)
    expect(gate.peak).toBe(DEFAULT_RUN_LAUNCH_WIDTH)
    expect(gate.waiting).toBe(DEFAULT_RUN_LAUNCH_WIDTH)
    expect(gate.calls).toBe(DEFAULT_RUN_LAUNCH_WIDTH)

    // When the queue drains
    await drain(gate, 41)

    // Then the bound held for the whole run and every member reached a session
    expect(gate.peak).toBe(DEFAULT_RUN_LAUNCH_WIDTH)
    expect(gate.calls).toBe(41)
    expect(started(ledger)).toBe(41)
  }, 30_000)

  it('operator running at width 1 sees the root start before its members, and every member still start', async () => {
    // Given a root with 40 subtasks and the narrowest width
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 40)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)

    // When the user runs the root
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await settle()

    // Then exactly one creation is in flight and nothing else was asked for
    expect(gate.peak).toBe(1)
    expect(gate.calls).toBe(1)

    // When the queue drains
    await drain(gate, 41)

    // Then no creation ever overlapped, the root's session was the very first
    // one created (so no member started before it) and nothing was dropped
    expect(gate.peak).toBe(1)
    expect(latest(ledger, 'root')?.sessionId).toBe('session-1')
    expect(started(ledger)).toBe(41)
    expect(ledger.state().tasks.filter(task => task.status === 'running')).toHaveLength(41)
  }, 30_000)

  it('operator running at width 16 sees the bound hold instead of the whole tree firing', async () => {
    // Given a root with 40 subtasks and the widest accepted width
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 40)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => RUN_LAUNCH_WIDTH_MAX)

    // When the user runs the root
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await settle()

    // Then the burst is the width, not the 41 participants: a queue that is
    // bypassed fires all 41 and turns this red
    expect(gate.peak).toBe(RUN_LAUNCH_WIDTH_MAX)
    expect(gate.calls).toBe(RUN_LAUNCH_WIDTH_MAX)

    await drain(gate, 41)
    expect(gate.peak).toBe(RUN_LAUNCH_WIDTH_MAX)
    expect(started(ledger)).toBe(41)
  }, 30_000)

  it('operator sees a member whose session cannot be created settle itself without holding the queue back', async () => {
    // Given a root with three subtasks and a gateway that refuses the second creation
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 3)
    const gate = createGate(ordinal => ordinal === 2 ? 'session create refused' : undefined)
    const service = serviceFor(ledger, gate, () => 1)

    // When the user runs the root and the queue drains
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await drain(gate, 4)
    await settle()

    // Then every member after the refused one was still asked for and started,
    // and only the refused one failed
    expect(gate.calls).toBe(4)
    expect(gate.created).toBe(3)
    expect(latest(ledger, 'member-0')?.result).toBe('failed')
    expect(latest(ledger, 'member-0')?.error).toContain('session create refused')
    expect(latest(ledger, 'member-0')?.sessionId).toBeUndefined()
    // The refused member consumed no session, so the two survivors are the
    // second and the third the gateway minted
    expect(latest(ledger, 'member-1')?.sessionId).toBe('session-2')
    expect(latest(ledger, 'member-2')?.sessionId).toBe('session-3')
    for (const id of ['member-1', 'member-2']) expect(latest(ledger, id)?.result).toBeUndefined()
    // The parent keeps waiting for the survivors rather than settling early
    expect(ledger.state().tasks.find(task => task.id === 'root')?.status).toBe('running')
    service.dispose()
  })

  it('user sees a parent wait for every member to settle before it leaves the running column', async () => {
    // Given a width-1 run whose members are still running
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 2)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await drain(gate, 3)
    await settle()

    // When one member fails and the other is still open
    const rootExecution = latest(ledger, 'root')?.id
    const aExecution = latest(ledger, 'member-0')?.id
    const bExecution = latest(ledger, 'member-1')?.id
    if (rootExecution === undefined || aExecution === undefined || bExecution === undefined) throw new Error('the run did not open every execution')
    ledger.settle('member-0', aExecution, 'failed', 'agent turn ended with an error')

    // Then only that member settled
    expect(ledger.state().tasks.find(task => task.id === 'member-0')?.status).toBe('failed')
    expect(ledger.state().tasks.find(task => task.id === 'member-1')?.status).toBe('running')
    expect(ledger.state().tasks.find(task => task.id === 'root')?.status).toBe('running')

    // When the survivors settle and the parent turn lands last
    ledger.settle('member-1', bExecution, 'succeeded')
    ledger.settle('root', rootExecution, 'succeeded')

    // Then the parent carries the failure
    const parent = ledger.state().tasks.find(task => task.id === 'root')
    expect(parent?.status).toBe('failed')
    expect(parent?.executions.at(-1)?.error).toBe('agent turn ended with an error')
    service.dispose()
  })

  it('operator switching the board off while members wait still sees every one of them start', async () => {
    // Given a width-1 run whose members are queued
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 3)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await settle()
    expect(gate.waiting).toBe(1)
    expect(gate.calls).toBe(1)

    // When the operator switches the board off mid-run
    service.setConfiguration(false, false)

    // Then the run it already opened still starts every member: the switch
    // governs new work, and a queued member is work this board already opened
    await drain(gate, 4)
    expect(gate.peak).toBe(1)
    expect(started(ledger)).toBe(4)
    service.dispose()
  })

  it('operator stopping the Host sees the members still waiting settle instead of staying running', async () => {
    // Given a width-1 run with 40 members waiting for a slot
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 40)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await settle()
    expect(gate.calls).toBe(1)
    expect(gate.waiting).toBe(1)

    // When the Host stops
    service.dispose()
    await settle()
    gate.releaseAll()
    await settle()

    // Then nothing new was ever asked for after the stop...
    expect(gate.calls).toBe(1)
    // ...and every member still waiting was settled out of the running column
    for (let index = 0; index < 40; index += 1) {
      const execution = latest(ledger, `member-${index}`)
      expect(execution?.result).toBe('cancelled')
      expect(execution?.error).toBe('host stopped before this execution started')
      expect(ledger.state().tasks.find(task => task.id === `member-${index}`)?.status).toBe('todo')
    }
    // Nothing is left open except the one launch that was already in flight
    const open = ledger.state().tasks.flatMap(task => task.executions).filter(entry => entry.endedAt === undefined)
    expect(open).toHaveLength(1)
    // The one launch that was already in flight follows the normal path: it
    // reached its session, so its card stays running for the next Host to observe.
    expect(latest(ledger, 'root')?.sessionId).toBe('session-1')
    expect(ledger.state().tasks.find(task => task.id === 'root')?.status).toBe('running')
  }, 30_000)

  it('operator sees a scheduled run still waiting when the Host stops refund its occurrence', async () => {
    // Given a cron rule whose occurrence fires while the single slot is busy
    let now = new Date(2026, 7, 16, 10, 0, 30).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('seed-busy', {
      kind: 'create', id: 'busy', input: { title: 'busy', description: '', prompt: 'busy' },
    })
    ledger.applyRequest('seed-sched', {
      kind: 'create', id: 'sched', input: {
        title: 'sched', description: '', prompt: 'scheduled work',
        schedule: { enabled: true, cron: '* * * * *', maxRuns: 2 },
      },
    })
    const gate = createGate()
    let last: { callback: () => void; delay: number } | undefined
    const timers = {
      timeout(callback: () => void, delay: number): () => void { last = { callback, delay }; return () => {} },
      interval(): () => void { return () => {} },
    }
    const service = new TaskBoardHostService(gate.gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      timers,
      now: () => now,
      runLaunchWidth: () => 1,
    })
    service.start()
    expect(last?.delay).toBe(30_000)
    service.apply('run-manual', { kind: 'run', taskId: 'busy' })
    await settle()
    expect(gate.inFlight).toBe(1)

    // When the rule fires and its launch cannot be admitted
    now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    last?.callback()
    await settle()
    expect(ledger.state().tasks.find(task => task.id === 'sched')?.schedule?.runCount).toBe(1)
    expect(gate.calls).toBe(1)

    // And the Host stops before the scheduled run ever started
    service.dispose()
    await settle()

    // Then the occurrence is refunded rather than silently spent, and the
    // scheduled card is not left in the running column
    expect(ledger.state().tasks.find(task => task.id === 'sched')?.schedule?.runCount).toBe(0)
    expect(latest(ledger, 'sched')?.result).toBe('cancelled')
    expect(ledger.state().tasks.find(task => task.id === 'sched')?.status).toBe('todo')
    gate.releaseAll()
    await settle()
  })

  it('operator raising the width while members wait sees them admitted sooner, with every one started', async () => {
    // Given a width-1 run whose members are waiting
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 6)
    let width = 1
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => width)
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await settle()
    expect(gate.calls).toBe(1)

    // When the operator raises the width while the run is still queueing
    width = 3
    gate.releaseAll()
    await settle()

    // Then the new width bounds the launches that had not been admitted yet
    expect(gate.peak).toBe(3)
    await drain(gate, 7)
    expect(gate.peak).toBe(3)
    expect(started(ledger)).toBe(7)
    service.dispose()
  })

  it('operator sees a member settled while it waits for a slot never start afterwards', async () => {
    // Given a width-1 run whose members are still waiting
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedTree(ledger, 2)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await settle()
    const queuedExecution = latest(ledger, 'member-1')?.id
    if (queuedExecution === undefined) throw new Error('the run did not open member-1')

    // When the operator force-settles that waiting member (task_board_manage settle)
    ledger.settle('member-1', queuedExecution, 'cancelled', 'settled by the operator')

    // Then it never gets a session of its own, and the members behind it still do
    await drain(gate, 2)
    await settle()
    expect(gate.calls).toBe(2)
    expect(latest(ledger, 'member-1')?.sessionId).toBeUndefined()
    expect(latest(ledger, 'member-0')?.sessionId).toBe('session-2')
    service.dispose()
  })

  it('user sees a team run spawn its teammates through the same queue', async () => {
    // Given a team root with five subtasks and a width of 2
    const ledger = new HostTaskLedger(root(), () => NOW)
    ledger.applyRequest('seed-root', {
      kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true },
    })
    for (let index = 0; index < 5; index += 1) {
      const id = `member-${index}`
      ledger.applyRequest('seed-' + id, {
        kind: 'create', id, input: { title: `member ${index}`, description: '', prompt: `work ${index}`, parentId: 'root' },
      })
    }
    const gate = createGate()
    const spawned: string[] = []
    const waiters: Array<() => void> = []
    let inFlight = 0
    let peak = 0
    const service = new TaskBoardHostService(gate.gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => NOW,
      runLaunchWidth: () => 2,
      team: {
        async spawn(input) {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise<void>(resolve => { waiters.push(resolve) })
          inFlight -= 1
          spawned.push(input.name)
          return { sessionId: 'member-' + input.name }
        },
      },
    })

    // When the user runs the team root and the Lead session exists
    service.apply('run-1', { kind: 'run', taskId: 'root' })
    await settle()
    // The Lead itself is one launch: it holds the queue until its session exists
    expect(gate.calls).toBe(1)
    gate.releaseAll()
    await settle()

    // Then only the width of teammates is being spawned at once
    expect(peak).toBe(2)
    expect(inFlight).toBe(2)
    // When the spawns drain
    for (let round = 0; round < 20 && spawned.length < 5; round += 1) {
      while (waiters.length > 0) waiters.shift()?.()
      await settle()
    }

    // Then the bound held and every member of the team was spawned
    expect(peak).toBe(2)
    expect(spawned).toHaveLength(5)
    expect(new Set(spawned).size).toBe(5)
    expect(ledger.state().tasks.filter(task => task.executions.at(-1)?.sessionId !== undefined)).toHaveLength(6)
    service.dispose()
  })
})

describe('run launch width setting', () => {
  it("operator's hand-edited width is normalized into the supported range", () => {
    // Given the published range (1..16) and default (3) of the admission width
    // When a hand-edited configuration value is normalized
    // Then every value lands inside the range, and a missing one takes the default
    expect(DEFAULT_RUN_LAUNCH_WIDTH).toBe(3)
    expect(normalizeRunLaunchWidth(undefined)).toBe(3)
    expect(normalizeRunLaunchWidth(Number.NaN)).toBe(3)
    expect(normalizeRunLaunchWidth(0)).toBe(1)
    expect(normalizeRunLaunchWidth(-5)).toBe(1)
    expect(normalizeRunLaunchWidth(2.7)).toBe(2)
    expect(normalizeRunLaunchWidth(RUN_LAUNCH_WIDTH_MAX)).toBe(16)
    expect(normalizeRunLaunchWidth(1000)).toBe(RUN_LAUNCH_WIDTH_MAX)
  })
})
