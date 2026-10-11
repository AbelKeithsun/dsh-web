/**
 * Team-run promotion for a parent card that just gained a subtask. A card with
 * subtasks is exactly what the Agent Team mode is for, so the two join actions
 * (create a subtask, link an existing task) opt the parent in — but only after
 * the Host confirmed the join, and only where the deployment serves Agent
 * Teams. A refused join changes nothing, and a parent that already opted in is
 * left alone rather than rewritten.
 *
 * Nothing here runs on mount or from a render effect: an existing card is only
 * ever touched by the user's own join action, so switching the option off by
 * hand stays off.
 */
import type { BoardController } from '../../core/controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'

/**
 * Whether a join would promote this parent: the deployment serves Agent Teams
 * and the parent has not opted in yet.
 * @param controller - the board controller (the snapshot carries both facts).
 * @param parent - the task that gained a subtask, if there is one.
 */
export function parentAwaitsTeamRunPromotion(controller: BoardController, parent: TaskRecord | undefined): boolean {
  if (parent === undefined) return false
  const snapshot = controller.getSnapshot()
  if (snapshot.host?.teamRunAvailable !== true) return false
  // The freshest record wins: the card may have been edited since this modal
  // opened with its own copy.
  return (snapshot.tasks.find(task => task.id === parent.id) ?? parent).teamRun !== true
}

/**
 * Opt the parent in after the Host confirmed the join.
 * @returns true when the opt-in was written; false when it did not apply.
 */
export async function promoteParentForTeamRun(controller: BoardController, parent: TaskRecord | undefined): Promise<boolean> {
  if (parent === undefined) return false
  if (!parentAwaitsTeamRunPromotion(controller, parent)) return false
  return await controller.updateTask(parent.id, { teamRun: true })
}
