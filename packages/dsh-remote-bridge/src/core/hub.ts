/**
 * The bridge's process-wide connection registry and its claim on
 * `approval/request`.
 *
 * The hub is what makes "phone not answering equals refusal" true: a question
 * is claimed only while at least one paired device is connected, the publish
 * has to actually reach someone, and every other path (timeout, agent
 * cancellation, the last phone leaving) delegates to the next answerer, which
 * the Host normalizes to `'unavailable'`.
 * @module dsh-remote-bridge/core/hub
 */

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { BridgeConnectionOptions, BridgeTransport, ConnectionAuth } from './connection.ts'
import { BridgeConnection } from './connection.ts'
import { TOPIC_APPROVAL_REQUEST } from './protocol.ts'

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
    const connection = new BridgeConnection(this.#options, transport, auth)
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
    const delivered = this.broadcast(TOPIC_APPROVAL_REQUEST, {
      sessionId,
      id: prompt.id,
      summary: prompt.summary,
      toolName: request.toolName,
    })
    // A question nobody could receive is withdrawn immediately instead of
    // waiting out the phone's timeout with the agent blocked on it.
    if (delivered === 0) this.#options.approvals.abandon([prompt.id])
    const answer = await prompt.answer
    return answer === undefined ? await next() : answer
  }

  /** Close every connection and withdraw every question. Idempotent. */
  dispose(): void {
    for (const connection of [...this.#connections]) {
      this.#connections.delete(connection)
      connection.dispose()
    }
    this.#options.approvals.abandonAll()
  }
}
