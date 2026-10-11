// @vitest-environment jsdom
/**
 * Joining a subtask promotes the parent to an Agent Team run: a parent that
 * gains a subtask is what the team mode is for, so the create and the link
 * actions turn the parent's own opt-in on — after the Host confirmed the
 * join, and only where the deployment serves Agent Teams. Nothing is written
 * when the join fails or is refused, and the user keeps full control of the
 * switch afterwards.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkSubtaskModal } from '../src/client/board/LinkSubtaskModal.tsx'
import { NewTaskModal } from '../src/client/board/NewTaskModal.tsx'
import { t } from '../src/client/locales.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { BoardController, type ControllerSnapshot, type TaskBoardTransport } from '../src/core/controller.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { TASK_BOARD_SCHEMA_VERSION, type TaskBoardSnapshot } from '../src/protocol.ts'
import { parentAwaitsTeamRunPromotion, promoteParentForTeamRun } from '../src/client/board/team-run-promotion.ts'
import type { TaskUpdatePatch } from '../src/core/use-cases/task-update.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

/** Real board controllers a host-backed scenario built, disposed after each test. */
const controllers: BoardController[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  for (const controller of controllers.splice(0)) controller.dispose()
  document.body.replaceChildren()
  window.localStorage.clear()
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'Task A', description: 'desc', prompt: 'do it' }, 0, 't1'), ...overrides }
}

function snapshotOf(tasks: TaskRecord[], teamRunAvailable = true): ControllerSnapshot {
  return {
    tasks,
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [], models: [] },
    pendingTaskIds: [],
    host: {
      revision: 1,
      scheduler: { timeZone: 'UTC' },
      power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
      sessionDefaultPermission: 'read-only',
      teamRunAvailable,
    },
  }
}

/** Mount one overlay the way its owner does, exposing the close callback it was given. */
function render(
  node: (controller: BoardController, onClose: () => void) => ReactNode,
  controller: BoardController,
): { container: HTMLElement; onClose: ReturnType<typeof vi.fn> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const onClose = vi.fn()
  act(() => { root.render(node(controller, onClose) as never) })
  return { container, onClose }
}

/** Submit the create form the way a user does. */
async function submitCreate(container: HTMLElement): Promise<void> {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

/** A create-modal controller whose Host confirms (or refuses) the creation. */
function createController(options: { created: TaskRecord | undefined; teamRunAvailable?: boolean; tasks?: TaskRecord[] }): {
  controller: BoardController
  createTaskConfirmed: ReturnType<typeof vi.fn>
  updateTask: ReturnType<typeof vi.fn>
} {
  const snapshot = snapshotOf(options.tasks ?? [], options.teamRunAvailable ?? true)
  const createTaskConfirmed = vi.fn(async () => options.created)
  const updateTask = vi.fn(async () => true)
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    createTaskConfirmed,
    updateTask,
    runTask: vi.fn(async () => true),
    openTask: vi.fn(),
  } as unknown as BoardController
  return { controller, createTaskConfirmed, updateTask }
}

describe('creating a subtask turns the parent into a team run', () => {
  it('user creating a subtask gets the parent opted in once the Host confirmed it', async () => {
    // Given an open "add subtask" dialog for a parent that is not a team run yet
    const parent = task({ id: 'parent' })
    const { controller, createTaskConfirmed, updateTask } = createController({ created: task({ id: 'child', parentId: 'parent' }), tasks: [parent] })
    const { container } = render((instance, onClose) => <NewTaskModal controller={instance} parentTask={parent} onClose={onClose} />, controller)

    // When the user submits the create form
    await submitCreate(container)

    // Then the subtask is created first, and only then is the parent opted in
    expect(createTaskConfirmed).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'parent' }))
    expect(updateTask).toHaveBeenCalledWith('parent', { teamRun: true })
    expect(createTaskConfirmed.mock.invocationCallOrder[0]!).toBeLessThan(updateTask.mock.invocationCallOrder[0]!)
  })

  it('user whose subtask creation is refused keeps the parent exactly as it was', async () => {
    // Given a Host that refuses the creation
    const parent = task({ id: 'parent' })
    const { controller, updateTask } = createController({ created: undefined, tasks: [parent] })
    const { container, onClose } = render((instance, close) => <NewTaskModal controller={instance} parentTask={parent} onClose={close} />, controller)

    // When the user submits the create form
    await submitCreate(container)

    // Then no parent opt-in is written and the dialog stays open with the error
    expect(container.textContent).toContain(t('new.required'))
    expect(updateTask).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('user creating a subtask on a deployment without Agent Teams gets no opt-in', async () => {
    // Given a deployment that serves no Agent Teams service
    const parent = task({ id: 'parent' })
    const { controller, updateTask } = createController({ created: task({ id: 'child', parentId: 'parent' }), tasks: [parent], teamRunAvailable: false })
    const { container } = render((instance, onClose) => <NewTaskModal controller={instance} parentTask={parent} onClose={onClose} />, controller)

    // When the subtask is created anyway
    await submitCreate(container)

    // Then the parent keeps its own setting, and the dialog never promised a promotion
    expect(container.textContent).not.toContain(t('exec.teamRunAutoHint'))
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('user adding a subtask under a parent that is already a team run leaves it untouched', async () => {
    // Given a parent that already opted in
    const parent = task({ id: 'parent', teamRun: true })
    const { controller, updateTask } = createController({ created: task({ id: 'child', parentId: 'parent' }), tasks: [parent] })
    const { container } = render((instance, onClose) => <NewTaskModal controller={instance} parentTask={parent} onClose={onClose} />, controller)

    // When another subtask is added
    await submitCreate(container)

    // Then no redundant write is made, and nothing claims a promotion either
    expect(container.textContent).not.toContain(t('exec.teamRunAutoHint'))
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('user creating a root task never touches any other card', async () => {
    // Given an ordinary new-task dialog (no parent)
    const other = task({ id: 'other' })
    const { controller, createTaskConfirmed, updateTask } = createController({ created: task({ id: 'fresh' }), tasks: [other] })
    const { container } = render((instance, onClose) => <NewTaskModal controller={instance} onClose={onClose} />, controller)

    // When the user creates a root task
    await submitCreate(container)

    // Then the create stays a root creation and no card is promoted
    expect((createTaskConfirmed.mock.calls[0]![0] as { parentId?: string }).parentId).toBeUndefined()
    expect(updateTask).not.toHaveBeenCalled()
  })
})

/** A link-modal controller whose Host confirms (or refuses) the link. */
function linkController(options: { linked: boolean; teamRunAvailable?: boolean; parent?: TaskRecord }): {
  controller: BoardController
  setParent: ReturnType<typeof vi.fn>
  updateTask: ReturnType<typeof vi.fn>
} {
  const parent = options.parent ?? task({ id: 'parent' })
  const snapshot = snapshotOf([parent, task({ id: 'root-b', title: 'Root B' })], options.teamRunAvailable ?? true)
  const setParent = vi.fn(async () => options.linked)
  const updateTask = vi.fn(async (_id: string, _patch: TaskUpdatePatch) => true)
  const controller = { getSnapshot: () => snapshot, subscribe: () => () => {}, setParent, updateTask } as unknown as BoardController
  return { controller, setParent, updateTask }
}

function linkButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === t('link.subtask.confirm'))
  if (button === undefined) throw new Error('no link action offered')
  return button as HTMLButtonElement
}

describe('linking an existing task under the parent turns the parent into a team run', () => {
  it('user linking a task gets the parent opted in and the dialog closed', async () => {
    // Given an open link dialog for a parent that is not a team run yet
    const parent = task({ id: 'parent' })
    const { controller, setParent, updateTask } = linkController({ linked: true, parent })
    const { container, onClose } = render((instance, close) => <LinkSubtaskModal controller={instance} parent={parent} onClose={close} />, controller)

    // When the user links the offered task
    await act(async () => { linkButton(container).click() })

    // Then the link is committed first, then the parent opt-in, then the close
    expect(setParent).toHaveBeenCalledWith('root-b', 'parent')
    expect(updateTask).toHaveBeenCalledWith('parent', { teamRun: true })
    expect(setParent.mock.invocationCallOrder[0]!).toBeLessThan(updateTask.mock.invocationCallOrder[0]!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('user whose link is refused keeps the parent exactly as it was', async () => {
    // Given a Host that refuses the link
    const parent = task({ id: 'parent' })
    const { controller, updateTask } = linkController({ linked: false, parent })
    const { container, onClose } = render((instance, close) => <LinkSubtaskModal controller={instance} parent={parent} onClose={close} />, controller)

    // When the user tries to link
    await act(async () => { linkButton(container).click() })

    // Then nothing is promoted and the dialog reports the refusal, still usable
    expect(container.textContent).toContain(t('new.required'))
    expect(linkButton(container).disabled).toBe(false)
    expect(updateTask).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('user linking on a deployment without Agent Teams gets no opt-in', async () => {
    // Given a deployment that serves no Agent Teams service
    const parent = task({ id: 'parent' })
    const { controller, updateTask } = linkController({ linked: true, teamRunAvailable: false, parent })
    const { container } = render((instance, close) => <LinkSubtaskModal controller={instance} parent={parent} onClose={close} />, controller)

    // When the link succeeds
    await act(async () => { linkButton(container).click() })

    // Then the success itself is not undone, no opt-in is written, and the
    // dialog never promised one
    expect(container.textContent).not.toContain(t('exec.teamRunAutoHint'))
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('user linking under a parent that already runs as a team leaves it untouched', async () => {
    // Given a parent that already opted in
    const parent = task({ id: 'parent', teamRun: true })
    const { controller, updateTask } = linkController({ linked: true, parent })
    const { container } = render((instance, close) => <LinkSubtaskModal controller={instance} parent={parent} onClose={close} />, controller)

    // When a task is linked
    await act(async () => { linkButton(container).click() })

    // Then no redundant write is made, and nothing claims a promotion either
    expect(container.textContent).not.toContain(t('exec.teamRunAutoHint'))
    expect(updateTask).not.toHaveBeenCalled()
  })
})

/**
 * A host-backed fake transport: it owns the authoritative cards and applies the
 * same update action the Host ledger applies, answering with a fresh snapshot —
 * so a scenario reads the card state a user ends up with rather than a
 * collaborator call log. addCard models the one writer that is not this window:
 * a card another window created exists on the Host while this window's mirror
 * is still stale.
 */
function hostLedger(initial: TaskRecord[], options: { actionUnreachable?: boolean } = {}): {
  transport: TaskBoardTransport
  cards: () => TaskRecord[]
  addCard: (card: TaskRecord) => void
} {
  let revision = 1
  let tasks = initial.map(card => ({ ...card }))
  const frame = (): TaskBoardSnapshot => ({
    schemaVersion: TASK_BOARD_SCHEMA_VERSION,
    revision,
    tasks: tasks.map(card => ({ ...card })),
    scheduler: { timeZone: 'UTC' },
    power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
    teamRunAvailable: true,
  })
  return {
    cards: () => tasks,
    addCard: (card) => { tasks = [...tasks, { ...card }] },
    transport: {
      bootstrap: async () => frame(),
      state: async () => frame(),
      action: async (action) => {
        if (options.actionUnreachable === true) throw new Error('host unreachable')
        if (action.kind === 'update') {
          tasks = tasks.map(card => (card.id === action.taskId ? { ...card, teamRun: action.patch.teamRun ?? card.teamRun } : card))
          revision += 1
        }
        return frame()
      },
      subscribe: () => () => undefined,
    },
  }
}

/** A real board controller served by that fake Host, mirroring it the way the browser does. */
async function hostBackedBoard(initial: TaskRecord[], options: { actionUnreachable?: boolean } = {}): Promise<{ controller: BoardController; host: ReturnType<typeof hostLedger> }> {
  const host = hostLedger(initial, options)
  const controller = new BoardController({
    store: new InMemoryTaskStore(),
    sessions: { current: () => undefined, open: () => undefined, subscribe: () => () => undefined },
    transport: host.transport,
    now: () => 0,
    uuid: () => 'unused',
  })
  controllers.push(controller)
  controller.start()
  await controller.retryHostSync()
  return { controller, host }
}

describe('team-run promotion for the parent card a join just gained', () => {
  it('user adding a subtask to no parent card leaves every card as it was', async () => {
    // Given a board whose Host serves Agent Teams
    const { controller } = await hostBackedBoard([task({ id: 'parent' })])

    // When a root creation asks whether there is a parent to promote, and then asks for the promotion
    const awaits = parentAwaitsTeamRunPromotion(controller, undefined)
    const promoted = await promoteParentForTeamRun(controller, undefined)

    // Then neither the hint nor the write claims anything, and the card keeps its own setting
    expect(awaits).toBe(false)
    expect(promoted).toBe(false)
    expect(controller.getSnapshot().transportError).toBeUndefined()
    expect(controller.getSnapshot().tasks.find(card => card.id === 'parent')?.teamRun).toBeUndefined()
  })

  it('user adding a subtask under a card this window has not mirrored yet still gets it opted in', async () => {
    // Given a parent another window just created on the Host, which this window's mirror cannot show yet
    const parent = task({ id: 'parent' })
    const { controller, host } = await hostBackedBoard([task({ id: 'other' })])
    host.addCard(parent)

    // When the join action asks for the promotion with the record its dialog holds
    const promoted = await promoteParentForTeamRun(controller, parent)

    // Then the Host stores the opt-in and the mirror picks the card up as a team run
    expect(promoted).toBe(true)
    expect(host.cards().find(card => card.id === 'parent')?.teamRun).toBe(true)
    expect(controller.getSnapshot().tasks.find(card => card.id === 'parent')?.teamRun).toBe(true)
  })

  it('user whose parent opt-in the Host cannot confirm sees it failed and the card unchanged', async () => {
    // Given a Host that serves Agent Teams but is unreachable when the write is submitted
    const parent = task({ id: 'parent' })
    const { controller } = await hostBackedBoard([parent], { actionUnreachable: true })

    // When the join action asks for the promotion
    const promoted = await promoteParentForTeamRun(controller, parent)

    // Then the failure is visible in the snapshot and the parent was never switched on
    expect(promoted).toBe(false)
    expect(controller.getSnapshot().transportError).toBe('host unreachable')
    expect(controller.getSnapshot().tasks.find(card => card.id === 'parent')?.teamRun).toBeUndefined()
  })

  it('user adding a subtask under a card another window already opted in leaves that setting alone', async () => {
    // Given a parent the board already mirrors as a team run
    const { controller } = await hostBackedBoard([task({ id: 'parent', teamRun: true })])

    // When the join action asks for the promotion with its own older copy of the card
    const promoted = await promoteParentForTeamRun(controller, task({ id: 'parent' }))

    // Then no write is made and the card keeps the team-run setting the other window stored
    expect(promoted).toBe(false)
    expect(controller.getSnapshot().tasks.find(card => card.id === 'parent')?.teamRun).toBe(true)
    expect(controller.getSnapshot().host?.revision).toBe(1)
  })
})
