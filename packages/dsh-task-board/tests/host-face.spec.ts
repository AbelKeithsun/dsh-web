/**
 * The `taskBoard` cordis service as an IN-PROCESS consumer sees it.
 *
 * The board publishes more than the provider-registration pair: the read/write
 * face the remote bridge forwards to a paired phone lives on the same service.
 * These tests mount the real activation and drive the board only through that
 * service, so what they observe is the board's own ledger and its own gates —
 * not a second path that could ever be more permissive than a browser.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { Config, apply } from '../src/index.ts'
import type { TaskBoardSnapshot, TaskBoardAction, TaskBoardVerificationOptions } from '../src/protocol.ts'
import { TASK_BOARD_SERVICE_NAME, type TaskBoardExtension } from '../src/core/extension.ts'

/** The face a consumer inside the Host process drives the board through. */
interface PublishedFace {
  registerExtension(extension: TaskBoardExtension): () => void
  isExtensionEnabled(extensionId: string): boolean
  snapshot(): TaskBoardSnapshot
  apply(requestId: string, action: TaskBoardAction, initiator?: string): TaskBoardSnapshot | Promise<TaskBoardSnapshot>
  subscribe(listener: () => void): () => void
  verificationOptions(): Promise<TaskBoardVerificationOptions>
}

/** One mounted activation, observed through the service it published. */
interface MountedFace {
  readonly face: PublishedFace
  dispose(): void
}

/** A gateway with no sessions: the board has nothing to reconcile here. */
function emptyGateway(): TypertGateway {
  return {
    invoke: async () => ({ items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

/**
 * Mount the board's host half into a capture-only context and keep the service
 * it published.
 * @param config - the parsed row config the Host hands the activation.
 */
function mountFace(config: ReturnType<typeof Config>): MountedFace {
  const disposers: (() => void)[] = []
  const published = new Map<string, unknown>()
  const ctx = {
    get: () => undefined,
    typertGateway: emptyGateway(),
    workspaceRegistry: {},
    agents: { get: () => undefined },
    commands: { execute: async () => undefined },
    systemPrompt: { section: () => () => undefined },
    webServer: { register: () => () => undefined },
    provide: (name: string, value: unknown) => {
      published.set(name, value)
      return () => { published.delete(name) }
    },
    effect: (body: () => unknown) => {
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
    on: () => () => undefined,
  }
  apply(ctx as never, config)
  const face = published.get(TASK_BOARD_SERVICE_NAME)
  if (face === undefined) throw new Error('the board published no taskBoard service')
  return {
    face: face as PublishedFace,
    dispose: () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

let previousHome: string | undefined
let scratchHome: string | undefined
const mounted: MountedFace[] = []

beforeEach(() => {
  // The activation builds a disk-backed ledger: keep every test off the real DSH home.
  previousHome = process.env.DSH_HOME
  scratchHome = mkdtempSync(join(tmpdir(), 'dsh-task-board-face-'))
  process.env.DSH_HOME = scratchHome
})

afterEach(() => {
  for (const board of mounted.splice(0)) board.dispose()
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
  scratchHome = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/** Mount one board and register it for teardown. */
function mount(config: ReturnType<typeof Config>): MountedFace {
  const board = mountFace(config)
  mounted.push(board)
  return board
}

describe('the published taskBoard service', () => {
  it('admin reads the read/write face beside the provider registration pair', () => {
    // Given a mounted board
    const board = mount(Config({ enabled: true }))
    // When a consumer inside the Host process reads the service it published
    const face = board.face as unknown as Record<string, unknown>
    // Then both the provider pair and the four capability members answer as functions
    for (const member of ['registerExtension', 'isExtensionEnabled', 'snapshot', 'apply', 'subscribe', 'verificationOptions']) {
      expect(typeof face[member]).toBe('function')
    }
  })

  it('admin reads the board through the face and receives the Host ledger document', () => {
    // Given a mounted board holding one card
    const board = mount(Config({ enabled: true }))
    board.face.apply('req-create', { kind: 'create', id: 'card', input: { title: 'Ship it', description: '', prompt: 'work' } })
    // When a consumer reads the board
    const snapshot = board.face.snapshot()
    // Then it sees the ledger's own shape, revision included
    expect(snapshot.schemaVersion).toBe(6)
    expect(snapshot.revision).toBeGreaterThan(0)
    expect(snapshot.tasks.map(task => task.id)).toEqual(['card'])
  })

  it('admin applying a move through the face gets the new revision back', async () => {
    // Given a mounted board with one card
    const board = mount(Config({ enabled: true }))
    const created = board.face.apply('req-create', { kind: 'create', id: 'card', input: { title: 'Ship it', description: '', prompt: 'work' } })
    const before = (await created).revision
    // When the consumer moves it through the same face
    const moved = await board.face.apply('req-move', { kind: 'move', taskId: 'card', status: 'done' })
    // Then the answer is the applied ledger, one revision newer
    expect(moved.revision).toBeGreaterThan(before)
    expect(moved.tasks[0]?.status).toBe('done')
  })

  it('admin is refused a run through the face when the card outranks the session permission', () => {
    // Given a card whose handover pins a permission above the read-only baseline
    const board = mount(Config({ enabled: true, sessionDefaultPermission: 'read-only' }))
    board.face.apply('req-create', {
      kind: 'create',
      id: 'elevated',
      input: {
        title: 'Elevated',
        description: '',
        prompt: 'work',
        handover: { permission: 'danger-full-access', references: [] },
      },
    })
    // When the consumer tries to run it through the published face
    const run = (): unknown => board.face.apply('req-run', { kind: 'run', taskId: 'elevated' })
    // Then the Host's own confirmation gate refuses it, exactly as for a browser
    expect(run).toThrow(/confirmation-required/)
    expect(board.face.snapshot().tasks[0]?.executions).toEqual([])
    expect(board.face.snapshot().tasks[0]?.status).toBe('todo')
  })

  it('admin hears about a change through the face until the subscription is released', async () => {
    // Given a mounted board and a listener subscribed through the face
    const board = mount(Config({ enabled: true }))
    let heard = 0
    const unsubscribe = board.face.subscribe(() => { heard += 1 })
    // When one action lands and the subscription is then released before another
    await board.face.apply('req-create', { kind: 'create', id: 'card', input: { title: 'Ship it', description: '', prompt: 'work' } })
    const afterFirst = heard
    unsubscribe()
    await board.face.apply('req-move', { kind: 'move', taskId: 'card', status: 'done' })
    // Then the first change was announced and the released listener heard nothing more
    expect(afterFirst).toBeGreaterThan(0)
    expect(heard).toBe(afterFirst)
  })

  it('admin reads the acceptance options through the face', async () => {
    // Given a mounted board
    const board = mount(Config({ enabled: true }))
    // When a consumer asks for the acceptance options
    const options = await board.face.verificationOptions()
    // Then the settings the card edits, the contract they resolve to, and the catalog all cross
    expect(options.settings).toEqual({ enabled: true, model: '', reasoningEffort: '' })
    expect(options.contract).toMatchObject({ enabled: true, preset: 'coding' })
    expect(options.catalog.groups).toEqual([])
  })
})
