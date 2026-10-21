/**
 * The bridge's process-wide connection registry and its claims on
 * `approval/request` and `user-questions/request`.
 *
 * The hub is what makes "phone not answering equals refusal" true: a question
 * is claimed only while at least one paired device is connected, the publish
 * has to actually reach someone, and every other path (timeout, agent
 * cancellation, the last phone leaving) delegates to the next answerer, which
 * the Host normalizes to `'unavailable'`.
 *
 * The claim on `user-questions/request` follows the same two rules, with two
 * differences that belong to the host's own semantics: delegating is not a
 * refusal, because only a phone that declares `questions.v1` is ever shown the
 * question; and a question is named on the wire even when the host named none,
 * because a blocking ask carries no call id and the phone still needs a handle
 * to answer with.
 * @module dsh-remote-bridge/core/hub
 */

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { PendingPromptView } from './approvals.ts'
import type { BridgeConnectionOptions, BridgeTransport, ConnectionAuth } from './connection.ts'
import { BridgeConnection } from './connection.ts'
import { CAP_APPROVALS, CAP_QUESTIONS, TOPIC_APPROVAL_REQUEST, TOPIC_QUESTION_REQUEST } from './protocol.ts'
import { questionPayload } from './questions.ts'
import type { QuestionAnswer, UserQuestionRequestLike } from './questions.ts'

/**
 * The fields of an approval question this bridge reads. Structural on purpose:
 * the event's own type is not exported from the package root, and only these
 * fields are ever touched.
 */
export interface ApprovalRequestLike {
  /** The agent asking; its id IS the session id (the event carries no session field). */
  readonly agent: { readonly id: string }
  readonly toolName: string
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  readonly signal?: AbortSignal
}

/** The summary line a phone shows for one question. */
export function approvalSummary(request: ApprovalRequestLike): string {
  return request.displayReason?.zh ?? request.displayReason?.en ?? request.toolName
}

/** The `approval.request` payload one claim is published with. */
export interface ApprovalRequestPayload {
  readonly sessionId: string
  readonly id: string
  readonly summary: string
  readonly toolName: string
}

/**
 * The `approval.request` payload for one claim.
 *
 * The first broadcast and the replay of a still-open claim go through this one
 * function, so the card a phone was originally shown and the same card handed to
 * it again after a reconnect cannot drift apart.
 * @param prompt - the claim being published.
 */
function approvalPayload(prompt: PendingPromptView): ApprovalRequestPayload {
  return { sessionId: prompt.sessionId, id: prompt.id, summary: prompt.summary, toolName: prompt.toolName }
}

/** The bridge's live connections plus the answerer it composes onto the approval chain. */
export class BridgeHub {
  readonly #options: BridgeConnectionOptions
  readonly #connections = new Set<BridgeConnection>()

  constructor(options: BridgeConnectionOptions) {
    this.#options = options
  }

  /** @returns how many paired devices could answer a question right now. */
  get pairedClients(): number {
    let count = 0
    for (const connection of this.#connections) if (connection.paired) count += 1
    return count
  }

  /**
   * Register one accepted socket.
   * @param transport - the carrier the connection writes through.
   * @param auth - the device the upgrade proved, when it carried a valid token.
   */
  attach(transport: BridgeTransport, auth?: ConnectionAuth): BridgeConnection {
    // The replay hook is wired here rather than by the caller: a phone that
    // reconnects mid-question was not there for the broadcast, and every
    // construction path has to hand it the live claims — the approval ones and
    // the user-question ones alike.
    const connection = new BridgeConnection(
      {
        ...this.#options,
        onDeclare: (fresh) => {
          this.replayQuestions(fresh)
          this.replayApprovals(fresh)
        },
      },
      transport,
      auth,
    )
    this.#connections.add(connection)
    connection.startHeartbeat()
    if (auth !== undefined) void this.#options.roster.touch(auth.deviceId).catch(() => undefined)
    this.#options.log(`connection open (${auth === undefined ? 'unpaired' : `device ${auth.deviceId}`})`)
    return connection
  }

  /**
   * Forget one connection and abort everything it owns. When it was the last
   * paired device, every pending question is withdrawn: nobody left can answer.
   */
  detach(connection: BridgeConnection): void {
    this.#connections.delete(connection)
    connection.dispose()
    if (this.pairedClients > 0) return
    const withdrawn = this.#options.approvals.abandonAll()
    if (withdrawn > 0) this.#options.log(`${withdrawn} approval question(s) withdrew: no paired device is connected`)
    // A user question is delegated rather than refused: the next answerer in the
    // host's chain decides, and the question's own deadline still holds.
    const released = this.#options.questions.withdrawAll()
    if (released > 0) this.#options.log(`${released} user question(s) released: no paired device is connected`)
  }

  /**
   * Publish one event to every paired device.
   * @returns how many connections actually took the frame.
   */
  broadcast(topic: string, payload: unknown): number {
    let delivered = 0
    for (const connection of this.#connections) {
      if (!connection.paired) continue
      if (connection.emit(topic, payload)) delivered += 1
    }
    return delivered
  }

  /**
   * Hand one freshly declared connection the questions it can now answer.
   *
   * Without this, a question raised while the phone was reconnecting stays on the
   * host with no card anywhere on the phone: the original broadcast was addressed
   * to clients that had already announced the channel.
   */
  replayQuestions(connection: BridgeConnection): void {
    if (!connection.paired || !connection.declares(CAP_QUESTIONS)) return
    for (const claim of this.#options.questions.openClaims()) {
      connection.emit(TOPIC_QUESTION_REQUEST, questionPayload('open', claim))
    }
  }

  /**
   * Hand one freshly declared connection the approvals it can now answer.
   *
   * The same shape as {@link replayQuestions} and for the same reason: the first
   * `approval.request` of a question was broadcast to the phones that were
   * connected at that instant, so a phone that reconnected — or a session screen
   * opened after the fact — holds no card and has no other way to learn the
   * question exists. Only unsettled questions are in the registry, so one that
   * was answered, one the bridge timed out and one withdrawn with the last phone
   * cannot be replayed.
   *
   * The replay emits a frame and nothing else: the claim keeps the deadline it
   * was opened with, so re-handing a question never lengthens how long the agent
   * waits for it.
   * @param connection - the connection that just declared its capabilities.
   */
  replayApprovals(connection: BridgeConnection): void {
    if (!connection.paired || !connection.declares(CAP_APPROVALS)) return
    for (const prompt of this.#options.approvals.openPrompts()) {
      connection.emit(TOPIC_APPROVAL_REQUEST, approvalPayload(prompt))
    }
  }

  /**
   * Publish one event to every paired device that announced a capability.
   * @returns how many connections actually took the frame.
   */
  broadcastTo(capability: string, topic: string, payload: unknown): number {
    let delivered = 0
    for (const connection of this.#connections) {
      if (!connection.paired || !connection.declares(capability)) continue
      if (connection.emit(topic, payload)) delivered += 1
    }
    return delivered
  }

  /**
   * The body of this plugin's `approval/request` listener.
   * @param request - the pending question.
   * @param next - the rest of the answerer chain.
   * @returns a claimed decision, or whatever the next answerer says.
   */
  async approve(request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (this.pairedClients === 0) return await next()
    const sessionId = request.agent.id
    const prompt = this.#options.approvals.open({
      sessionId,
      toolName: request.toolName,
      summary: approvalSummary(request),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const delivered = this.broadcast(TOPIC_APPROVAL_REQUEST, approvalPayload(prompt))
    // A question nobody could receive is withdrawn immediately instead of
    // waiting out the phone's timeout with the agent blocked on it.
    if (delivered === 0) this.#options.approvals.abandon([prompt.id])
    // Only a claim that reached someone is worth a notification: the question a
    // withdrawn claim stood for can no longer be answered by any phone, and a
    // notification about it would be a card with nothing behind it (§28.5).
    else this.#options.push?.notify('approval', sessionId)
    const answer = await prompt.answer
    return answer === undefined ? await next() : answer
  }

  /**
   * The body of this plugin's `user-questions/request` listener.
   *
   * Claimed only while a paired device is connected and the ask names an agent:
   * the payload has no session field of its own, and a question nobody can be
   * told about is not one this bridge may hold. The wire id is the host's own
   * when the ask is timed, and minted here when it is blocking and the host
   * assigned none — either way the phone answers the id it was shown. A claim
   * nobody received is withdrawn at once instead of holding the agent until the
   * host's deadline. For a timed ask the host's own remaining wait travels with
   * the first frame as `expiresAt`, and every later move of that deadline is
   * re-published under the same call id.
   * @param request - the pending question batch.
   * @param next - the rest of the answerer chain.
   * @returns the phone's answer, the host's own deadline outcome, or whatever the next answerer says.
   */
  async question(request: UserQuestionRequestLike, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    const sessionId = request.agent?.id
    if (sessionId === undefined) return await next()
    if (this.pairedClients === 0) return await next()
    // A blocking ask carries no `wait`: the host has no call id for it, but the
    // phone needs a handle to answer with, so one is minted in this bridge's own
    // namespace. Resolving the promise held here needs no host identity.
    const hosted = request.wait?.callId
    const callId = hosted ?? this.#options.questions.mintCallId()
    const claim = this.#options.questions.open({
      sessionId,
      callId,
      hosted: hosted !== undefined,
      questions: request.questions,
      next,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onSettled: (question): void => {
        // The phone's card has to go when the desktop answered it, or the phone
        // keeps offering a question that no longer exists.
        this.broadcastTo(CAP_QUESTIONS, TOPIC_QUESTION_REQUEST, questionPayload('settled', question))
      },
      onContinued: (question): void => {
        // The foreground wait ended, but the question is still answerable: the
        // phone is told which state it is in instead of losing the question.
        this.broadcastTo(CAP_QUESTIONS, TOPIC_QUESTION_REQUEST, questionPayload('continued', question))
      },
      onDeadline: (question): void => {
        // The host moved its deadline. Re-publishing the open state under the same
        // call id updates the card the phone already holds instead of opening a
        // second one.
        this.broadcastTo(CAP_QUESTIONS, TOPIC_QUESTION_REQUEST, questionPayload('open', question))
      },
    })
    if (claim === undefined) return await next()
    // The host's own first wait frame is folded into this same frame: a phone is
    // handed the question and how long it has together, rather than a card that a
    // second update then races. A claim with no frame publishes no deadline,
    // which is exactly the payload from before this channel existed.
    const expiresAt = await claim.deadline
    // The host's own lifetime can end while the first wait frame is still being
    // awaited — its signal aborts, so the claim is expired or already continued.
    // Publishing now would hand the phone a card nobody can retract, so that case
    // goes straight to the claim's own outcome: the host's reason, or its answer.
    if (this.#options.questions.stateOf(callId) !== 'open') return await claim.answer
    const delivered = this.broadcastTo(CAP_QUESTIONS, TOPIC_QUESTION_REQUEST, questionPayload('open', expiresAt === undefined ? claim : { ...claim, expiresAt }))
    // A client that cannot receive this is not going to receive it later: the claim
    // must not be left holding the host's ask with no card anywhere. A client that
    // *can* receive it but was reconnecting is a different case — it is handed the
    // live claims by `onDeclare` when it comes back.
    if (delivered === 0) this.#options.questions.withdraw([callId])
    // Same rule as the approval above: a question this bridge could not hand to
    // a connected phone is withdrawn at once, so a notification would announce
    // something already gone.
    else this.#options.push?.notify('question', sessionId)
    return await claim.answer
  }

  /** Close every connection and withdraw every question. Idempotent. */
  dispose(): void {
    for (const connection of [...this.#connections]) {
      this.#connections.delete(connection)
      connection.dispose()
    }
    this.#options.approvals.abandonAll()
    this.#options.questions.withdrawAll()
  }
}
