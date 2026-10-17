/**
 * The bridge's claims on `user-questions/request`: which questions a phone may
 * answer, and the one path an answer travels back into the host.
 *
 * The host asks in two shapes, and they are two shapes of the SAME channel:
 *
 * - a timed ask (`askTimed`, the tool schema that declares a `timeout`) rides
 *   the waterfall with a `wait.callId`. While it is open the bridge HOLDS the
 *   host's promise, so the answer is that promise's resolution — exactly what an
 *   in-process answerer does, and the only way an open question can be answered
 *   at all (`ctx.userQuestions.answer` refuses an open question by returning
 *   false). Once the host's own deadline released the model, the ask is gone and
 *   the question can only be answered through the host's Remote `answer`, which
 *   steers the reply into the agent as a queued user message.
 * - a blocking ask (the schema without `timeout`, which is the `ask_user_question`
 *   a phone actually shows) carries NO `wait` at all, and the host assigns no
 *   call id. It is still claimed, and the bridge mints its own opaque id for the
 *   wire — resolving the promise it holds needs no host identity at all. Such a
 *   question is only ever `open`: the host has no deadline for it, so it never
 *   becomes `continued` and never takes the Remote `answer` path.
 *
 * Every claim is one record keyed by the id published on the wire, so an answer
 * that arrives late still lands, and an answer for an id this bridge never
 * claimed is refused instead of being forwarded to the host blindly.
 *
 * The bridge invents no deadline, for either shape: a timed ask's deadline is
 * the host's own and is only propagated here, and a blocking ask simply has
 * none — a phone that never answers leaves it open for as long as the asker
 * waits. It also never fabricates a refusal: a question nobody can answer is
 * delegated to `next()`, never answered with a decision the operator did not
 * make.
 *
 * The types below mirror `@deepseek-ai/dsh-user-questions` field for field. The
 * package is not a dependency of this one (it is the host's, not the bridge's),
 * so the contract is declared locally instead of imported.
 * @module dsh-remote-bridge/core/questions
 */

import { randomBase64Url } from './crypto.ts'
import { errorCodeOf, failureText, withServiceUnavailableRetry } from './gateway-errors.ts'
import { CODE_INTERNAL, CODE_QUESTION_UNKNOWN } from './protocol.ts'
import { wireArgs, type BridgeGateway } from './wire.ts'

/** One selectable answer offered by the asker. */
export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question, in the field names protocol v1 publishes. */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly QuestionOption[]
  readonly multiSelect?: boolean
}

/** One item of the answer batch. */
export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The whole answer batch the host's ask is settled with. */
export interface QuestionAnswer {
  readonly answers: readonly QuestionAnswerItem[]
}

/** Whether a question still holds the foreground ask, or only its late reply. */
export type QuestionState = 'open' | 'continued'

/** `question.request`'s payload, as frozen by the contract. */
export interface QuestionRequestPayload {
  readonly sessionId: string
  readonly callId: string
  readonly state: QuestionState
  readonly questions: readonly QuestionItem[]
  /** Epoch milliseconds; absent when the host published no readable deadline. */
  readonly expiresAt?: number
}

/**
 * The fields of a host question request this bridge reads.
 *
 * Structural on purpose, for the reason the approval listener is: the event's
 * own type is not reachable from here, and only these fields are ever touched.
 * `wait` is the host's own field for the timed schema — it is what carries the
 * call id, and it is absent for a legacy blocking ask, which this bridge
 * therefore delegates rather than claims.
 */
export interface UserQuestionRequestLike {
  readonly questions: readonly QuestionItem[]
  /** The agent asking; its id IS the session id (the event carries no session field). */
  readonly agent?: { readonly id: string }
  readonly signal?: AbortSignal
  readonly wait?: { readonly callId?: string; readonly timed?: boolean }
}

/** The identity and content of one claim, as the hub publishes it. */
export interface ClaimedQuestionView {
  readonly sessionId: string
  readonly callId: string
  readonly questions: readonly QuestionItem[]
}

/** One claim the hub holds while the host's ask is still open. */
export interface ClaimedQuestion extends ClaimedQuestionView {
  /** The host's ask: the phone's answer, or whatever the next answerer says. */
  readonly answer: Promise<QuestionAnswer>
}

/** What one `question.answer` produced: acknowledgement, or the refusal to send. */
export type QuestionReply = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly msg: string }

/** The code the host raises when its own foreground deadline ends the ask. */
export const QUESTION_TIMED_OUT_CODE = 'ASK_TIMED_OUT'
/**
 * Prefix of a call id this bridge minted for a question the host never named.
 *
 * A blocking ask has no host call id, but the phone still needs one opaque
 * handle to answer with. The prefix keeps that handle in a namespace of its own,
 * so a minted id can never be mistaken for a host `ToolCallId` — by this bridge
 * or by anything reading the wire.
 */
export const MINTED_CALL_ID_PREFIX = 'bridge:'
/** Entropy of one minted call id. */
export const MINTED_CALL_ID_BYTES = 16

export interface OpenQuestionInput {
  readonly sessionId: string
  /** The id published on the wire: the host's own, or one this bridge minted. */
  readonly callId: string
  /**
   * Whether `callId` is the host's own tool call identity.
   *
   * Only a hosted claim can ever be `continued`: the state is what a host
   * deadline produces, and the late-answer path needs a real call id to address.
   */
  readonly hosted: boolean
  readonly questions: readonly QuestionItem[]
  /** The rest of the answerer chain, used when the bridge withdraws. */
  readonly next: () => Promise<QuestionAnswer>
  /** The host's own cancellation lifetime for this ask. */
  readonly signal?: AbortSignal
  /** Called once when the host's deadline released the model but the question stayed answerable. */
  readonly onContinued?: (question: ClaimedQuestionView) => void
}

/** One live claim, with every path that settles it. */
interface Claim {
  readonly sessionId: string
  readonly callId: string
  readonly hosted: boolean
  readonly questions: readonly QuestionItem[]
  state: QuestionState
  readonly settle: (answer: QuestionAnswer) => void
  readonly fail: (reason: unknown) => void
  readonly delegate: () => void
  readonly detach: () => void
  readonly onContinued: ((question: ClaimedQuestionView) => void) | undefined
}

export interface QuestionClaimsOptions {
  readonly gateway: BridgeGateway
  readonly log: (message: string) => void
  /** Id source, injectable so a test can answer the exact id it was given. */
  readonly random?: (byteLength: number) => string
}

/** @returns whether a failure is the host's own foreground deadline. */
function isTimedOut(reason: unknown): boolean {
  return (reason as { code?: unknown } | null | undefined)?.code === QUESTION_TIMED_OUT_CODE
}

/**
 * Project a host question into the contract's own fields.
 *
 * Explicitly field by field: the host's items carry presentation intents this
 * protocol does not publish, and a payload that grew a key the contract does
 * not declare would be a wire change nobody agreed to.
 * @param items - the host's question batch.
 * @returns the same questions in protocol vocabulary.
 */
export function projectQuestions(items: readonly QuestionItem[]): readonly QuestionItem[] {
  return items.map(item => ({
    id: item.id,
    question: item.question,
    ...(item.header === undefined ? {} : { header: item.header }),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.options === undefined
      ? {}
      : {
          options: item.options.map(option => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }),
    ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }),
  }))
}

/**
 * Pending questions of one bridge process.
 *
 * One record per id published on the wire — the host's own, or one minted here
 * for a blocking ask — and one settle for every path (answer, the host's
 * deadline, the last phone leaving, bridge unload), so a question can never be
 * settled twice and a withdrawn claim leaves no abort listener behind.
 */
export class QuestionClaims {
  readonly #gateway: BridgeGateway
  readonly #log: (message: string) => void
  readonly #random: (byteLength: number) => string
  readonly #claims = new Map<string, Claim>()

  constructor(options: QuestionClaimsOptions) {
    this.#gateway = options.gateway
    this.#log = options.log
    this.#random = options.random ?? randomBase64Url
  }

  /** @returns how many questions this bridge currently holds. */
  get size(): number {
    return this.#claims.size
  }

  /**
   * Mint the opaque wire id of a question the host never named.
   * @returns an id in this bridge's own namespace.
   */
  mintCallId(): string {
    return `${MINTED_CALL_ID_PREFIX}${this.#random(MINTED_CALL_ID_BYTES)}`
  }

  /** @returns the state of one claimed call, or undefined when it is not claimed. */
  stateOf(callId: string): QuestionState | undefined {
    return this.#claims.get(callId)?.state
  }

  /**
   * Claim one question.
   * @param input - session identity, wire call id and its provenance, questions, the rest of the chain, and the host's lifetime.
   * @returns the claim the hub publishes, or undefined when this call id is already claimed.
   */
  open(input: OpenQuestionInput): ClaimedQuestion | undefined {
    if (this.#claims.has(input.callId)) return undefined
    let settle: (answer: QuestionAnswer) => void = () => undefined
    let fail: (reason: unknown) => void = () => undefined
    const answer = new Promise<QuestionAnswer>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    const signal = input.signal
    const onAbort = (): void => { this.#expire(input.callId, signal?.reason) }
    const record: Claim = {
      sessionId: input.sessionId,
      callId: input.callId,
      hosted: input.hosted,
      questions: projectQuestions(input.questions),
      state: 'open',
      settle,
      fail,
      delegate: (): void => {
        let pending: Promise<QuestionAnswer>
        try {
          pending = input.next()
        } catch (error) {
          fail(error)
          return
        }
        void pending.then(settle, fail)
      },
      detach: (): void => { signal?.removeEventListener('abort', onAbort) },
      onContinued: input.onContinued,
    }
    this.#claims.set(input.callId, record)
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    return { sessionId: record.sessionId, callId: record.callId, questions: record.questions, answer }
  }

  /**
   * Answer one claimed question.
   *
   * An open claim is settled by resolving the host's own ask; a continued one
   * only through the host's Remote `answer`, whose result and failures cross
   * unchanged.
   * @param sessionId - the session the client believes owns the question.
   * @param callId - the wire call id the client was shown.
   * @param answer - the complete answer batch.
   */
  async answer(sessionId: string, callId: string, answer: QuestionAnswer): Promise<QuestionReply> {
    const record = this.#claims.get(callId)
    if (record === undefined || record.sessionId !== sessionId) {
      return { ok: false, code: CODE_QUESTION_UNKNOWN, msg: 'the question is unknown, already answered or not this bridge\'s to answer' }
    }
    if (record.state === 'open') {
      this.#claims.delete(callId)
      record.detach()
      record.settle({ answers: answer.answers })
      return { ok: true }
    }
    // Unreachable today: only a host deadline marks a claim continued, and only a
    // hosted claim can reach one. Kept as the invariant an answer path must hold.
    if (!record.hosted) {
      return { ok: false, code: CODE_QUESTION_UNKNOWN, msg: 'the question is not one the host can take a late answer for' }
    }
    return await this.#forward(sessionId, callId, answer)
  }

  /**
   * Withdraw the named questions, delegating each to the next answerer.
   * @returns how many were still open and therefore delegated.
   */
  withdraw(callIds: readonly string[]): number {
    let withdrawn = 0
    for (const callId of callIds) {
      const record = this.#claims.get(callId)
      if (record === undefined) continue
      this.#claims.delete(callId)
      record.detach()
      if (record.state !== 'open') continue
      record.delegate()
      withdrawn += 1
    }
    return withdrawn
  }

  /**
   * Withdraw every claim, delegating each open question to the next answerer.
   * Called when the last paired phone goes away and when the bridge unloads: a
   * question nobody can answer must not hold the agent until its own deadline.
   * @returns how many questions were still open.
   */
  withdrawAll(): number {
    return this.withdraw([...this.#claims.keys()])
  }

  /**
   * Ask the host to steer one continued answer into its agent.
   *
   * A host that answers `false` no longer holds the question; it is reported,
   * not swallowed, and the claim is kept so a client that answered a beat too
   * early can retry once the host has folded the pending result.
   */
  async #forward(sessionId: string, callId: string, answer: QuestionAnswer): Promise<QuestionReply> {
    try {
      const accepted = await withServiceUnavailableRetry(() => this.#gateway.invoke({
        namespace: 'userQuestions',
        method: 'answer',
        args: wireArgs('userQuestions', 'answer', { agentId: sessionId, callId, answer: { answers: answer.answers } }),
      }))
      if (accepted !== true) {
        return { ok: false, code: CODE_QUESTION_UNKNOWN, msg: 'the host does not hold this question as answerable yet' }
      }
      this.#claims.delete(callId)
      return { ok: true }
    } catch (error) {
      this.#log(`userQuestions/answer failed: ${failureText(error)}`)
      return { ok: false, code: errorCodeOf(error, CODE_INTERNAL), msg: failureText(error) }
    }
  }

  /**
   * Settle one open claim from the host's own cancellation lifetime.
   *
   * The reason is propagated verbatim, so the host's deadline still maps to its
   * pending result. Only a deadline keeps the claim: every other abort means
   * the ask itself is gone.
   */
  #expire(callId: string, reason: unknown): void {
    const record = this.#claims.get(callId)
    if (record === undefined || record.state !== 'open') return
    record.detach()
    record.fail(reason)
    // Only a host deadline keeps a claim answerable, and only for an id the host
    // itself assigned: a minted one has no host question behind it, so nothing
    // could ever take a late answer.
    if (!record.hosted || !isTimedOut(reason)) {
      this.#claims.delete(callId)
      return
    }
    record.state = 'continued'
    record.onContinued?.({ sessionId: record.sessionId, callId: record.callId, questions: record.questions })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for structured user input; the bridge claims it
     * while a paired phone is connected, and delegates every other case. The
     * parameters are the ones this package reads — the host's own declaration
     * is not reachable from here.
     * @mode waterfall
     */
    'user-questions/request'(this: unknown, request: UserQuestionRequestLike, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer>
  }
}
