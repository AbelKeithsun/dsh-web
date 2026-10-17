import { describe, expect, it } from 'vitest'
import { requestFrame, answerOf, makeBareHub, makeConnection, makeHub, RecordingTransport } from './support/harness.ts'
import type { QuestionAnswer, UserQuestionRequestLike } from '../src/core/questions.ts'

/** The host's own foreground deadline, in the shape `askTimed` raises it. */
function hostTimeout(): Error & { code: string } {
  return Object.assign(new Error('ask_user_question timed out before the user answered'), { code: 'ASK_TIMED_OUT' })
}

/** One pending question as the host's waterfall carries it. */
function hostRequest(overrides: Partial<UserQuestionRequestLike> = {}): UserQuestionRequestLike {
  return {
    agent: { id: 's-1' },
    wait: { callId: 'c-1', timed: true },
    questions: [
      {
        id: 'q-1',
        question: 'Which deck?',
        header: 'Deck',
        detail: 'Pick exactly one.',
        options: [{ label: 'Alpha', description: 'the first' }, { label: 'Beta' }],
        multiSelect: false,
      },
    ],
    ...overrides,
  }
}

/** The answer a phone sends for {@link hostRequest}'s single question. */
const ANSWER: QuestionAnswer = { answers: [{ id: 'q-1', selected: ['Alpha'] }] }

/**
 * The host's own answerer with its panel open and nobody having touched it: in the
 * desktop client this settles when a human clicks. Pending is the honest model,
 * and it is what lets the phone and the desktop race each other.
 */
const desktopWaiting = (): Promise<QuestionAnswer> => new Promise<QuestionAnswer>(() => {})

/** Declare the question capability on one connection. */
async function declareQuestions(connection: { handleText(text: string): Promise<void> }, id = 1): Promise<void> {
  await connection.handleText(requestFrame(id, 'hello', { proto: 1, cap: ['questions.v1'] }))
}

/** @returns the payload of every `question.request` frame the carrier took. */
function questionPayloads(transport: RecordingTransport): Record<string, unknown>[] {
  return transport.ofType('ev')
    .filter(frame => frame.m === 'question.request')
    .map(frame => frame.p as Record<string, unknown>)
}

describe('user question bridge', () => {
  it('operator runs with no paired device and the question is delegated untouched', async () => {
    // Given a hub whose only connection never paired
    const harness = makeHub({ paired: false })
    let delegated = 0
    const answerer = async (): Promise<QuestionAnswer> => {
      delegated += 1
      return { answers: [] }
    }
    // When the host asks
    const outcome = await harness.hub.question(hostRequest(), answerer)
    // Then the next answerer decided, nothing was published and nothing is held
    expect(delegated).toBe(1)
    expect(outcome).toEqual({ answers: [] })
    expect(harness.transport.ofType('ev')).toEqual([])
    expect(harness.questions.size).toBe(0)
  })

  it('user of a client that declares the capability receives the whole question batch in contract field names', async () => {
    // Given a paired phone that announced questions.v1
    const harness = makeHub()
    await declareQuestions(harness.connection)
    // When the host asks
    const pending = harness.hub.question(hostRequest(), desktopWaiting)
    // Then the event carries the frozen payload, and the host's ask is still open
    expect(questionPayloads(harness.transport)).toEqual([
      {
        sessionId: 's-1',
        callId: 'c-1',
        state: 'open',
        questions: [
          {
            id: 'q-1',
            question: 'Which deck?',
            header: 'Deck',
            detail: 'Pick exactly one.',
            options: [{ label: 'Alpha', description: 'the first' }, { label: 'Beta' }],
            multiSelect: false,
          },
        ],
      },
    ])
    expect(harness.questions.size).toBe(1)
    expect(harness.questions.stateOf('c-1')).toBe('open')
    // When the user answers it, the host's own ask is settled with that batch
    await harness.connection.handleText(requestFrame(2, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    expect(answerOf(harness, 2)).toEqual({ ok: true, r: { ok: true } })
    expect(await pending).toEqual(ANSWER)
    expect(harness.questions.size).toBe(0)
    // And nothing was sent to the host's Remote surface: the open question IS the ask
    expect(harness.gateway.invocations).toEqual([])
  })

  it('user answers a continued question and the host receives the answer method call', async () => {
    // Given a claimed question whose foreground deadline is the host's own
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const controller = new AbortController()
    const timeout = hostTimeout()
    const pending = harness.hub.question(hostRequest({ signal: controller.signal }), desktopWaiting)
    // When the host's deadline elapses
    controller.abort(timeout)
    // Then the host's own reason crosses back into its ask unchanged
    await expect(pending).rejects.toBe(timeout)
    // And the phone is told the question is still answerable, but no longer foreground
    expect(questionPayloads(harness.transport).map(payload => payload.state)).toEqual(['open', 'continued'])
    expect(harness.questions.stateOf('c-1')).toBe('continued')
    // When the user answers the continued question
    harness.gateway.handler = async () => true
    await harness.connection.handleText(requestFrame(3, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    // Then it travelled through the host's Remote answer, exactly as the descriptor declares
    expect(answerOf(harness, 3)).toEqual({ ok: true, r: { ok: true } })
    expect(harness.gateway.lastArgs('userQuestions', 'answer')).toEqual({
      agentId: 's-1',
      callId: 'c-1',
      answer: { answers: ANSWER.answers },
    })
    expect(harness.questions.size).toBe(0)
  })

  it('user answers a continued question and a host failure crosses with the host code', async () => {
    // Given a continued question
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const controller = new AbortController()
    const pending = harness.hub.question(hostRequest({ signal: controller.signal }), desktopWaiting)
    controller.abort(hostTimeout())
    await expect(pending).rejects.toBeDefined()
    // When the host refuses the reply it already queued
    harness.gateway.handler = async () => { throw Object.assign(new Error('a reply is already queued for this question'), { code: 'REPLY_QUEUED' }) }
    await harness.connection.handleText(requestFrame(4, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    // Then the phone sees the host's own code and message rather than a bridge verdict
    expect(answerOf(harness, 4).e).toEqual({ code: 'REPLY_QUEUED', msg: 'a reply is already queued for this question' })
    expect(harness.questions.size).toBe(1)
  })

  it('user answers a continued question the host already forgot and the claim is kept for a retry', async () => {
    // Given a continued question
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const controller = new AbortController()
    const pending = harness.hub.question(hostRequest({ signal: controller.signal }), desktopWaiting)
    controller.abort(hostTimeout())
    await expect(pending).rejects.toBeDefined()
    // When the host answers that it no longer holds the question
    harness.gateway.handler = async () => false
    await harness.connection.handleText(requestFrame(13, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    // Then the phone is told the host has nothing to take, and the claim survives a later try
    expect(answerOf(harness, 13).e?.code).toBe('question-unknown')
    expect(harness.questions.stateOf('c-1')).toBe('continued')
    harness.gateway.handler = async () => true
    await harness.connection.handleText(requestFrame(14, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    expect(answerOf(harness, 14)).toEqual({ ok: true, r: { ok: true } })
    expect(harness.questions.size).toBe(0)
  })

  it('operator unloads the bridge and every held question is delegated', async () => {
    // Given two claimed questions
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const first = harness.hub.question(hostRequest(), async () => ({ answers: [{ id: 'q-1', selected: [] }] }))
    const second = harness.hub.question(hostRequest({ wait: { callId: 'c-2', timed: true } }), async () => ({ answers: [{ id: 'q-1', selected: [] }] }))
    // When the plugin is torn down
    harness.hub.dispose()
    // Then both are delegated and nothing is left holding them
    expect(await first).toEqual({ answers: [{ id: 'q-1', selected: [] }] })
    expect(await second).toEqual({ answers: [{ id: 'q-1', selected: [] }] })
    expect(harness.questions.size).toBe(0)
  })

  it('user answers a call this bridge never claimed and is refused as unknown', async () => {
    // Given a paired phone that announced the capability
    const harness = makeConnection({ paired: true })
    await declareQuestions(harness.connection)
    // When it answers a call id no bridge claim carries
    await harness.connection.handleText(requestFrame(5, 'question.answer', { sessionId: 's-1', callId: 'c-nope', answers: ANSWER.answers }))
    // Then the refusal is unknown and nothing reached the host
    expect(answerOf(harness, 5).e?.code).toBe('question-unknown')
    expect(harness.gateway.invocations).toEqual([])
  })

  it('user answers a claimed call from another session and is refused as unknown', async () => {
    // Given one claimed question on session s-1
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const pending = harness.hub.question(hostRequest(), desktopWaiting)
    // When the phone names a different session for that call id
    await harness.connection.handleText(requestFrame(6, 'question.answer', { sessionId: 's-2', callId: 'c-1', answers: ANSWER.answers }))
    // Then the claim is not handed to whoever names it
    expect(answerOf(harness, 6).e?.code).toBe('question-unknown')
    expect(harness.questions.size).toBe(1)
    // And the real session can still answer it
    await harness.connection.handleText(requestFrame(7, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    expect(await pending).toEqual(ANSWER)
  })

  it('user answers twice and the second answer is refused as unknown', async () => {
    // Given a question already answered
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const pending = harness.hub.question(hostRequest(), desktopWaiting)
    await harness.connection.handleText(requestFrame(8, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    // When the same call is answered again
    await harness.connection.handleText(requestFrame(9, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    // Then the stale answer is refused and the first one stands
    expect(answerOf(harness, 9).e?.code).toBe('question-unknown')
    expect(await pending).toEqual(ANSWER)
  })

  it('user sends an answer batch of the wrong shape and is refused with the argument names', async () => {
    // Given a paired phone that announced the capability
    const harness = makeConnection({ paired: true })
    await declareQuestions(harness.connection)
    // When the batch is not a list of {id, selected[]}
    await harness.connection.handleText(requestFrame(10, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: [{ id: 'q-1', selected: 'Alpha' }] }))
    await harness.connection.handleText(requestFrame(11, 'question.answer', { sessionId: 's-1', callId: 'c-1' }))
    // Then both are refused by the argument contract, not as unknown questions
    expect(answerOf(harness, 10).e?.code).toBe('invalid-args')
    expect(answerOf(harness, 11).e?.code).toBe('invalid-args')
    expect(harness.questions.size).toBe(0)
  })

  it('user of a client written before the channel sees no event and its answer is an unknown method', async () => {
    // Given a paired phone that never declared the capability
    const harness = makeHub()
    let delegated = 0
    const answerer = async (): Promise<QuestionAnswer> => {
      delegated += 1
      return { answers: [] }
    }
    // When the host asks
    const outcome = await harness.hub.question(hostRequest(), answerer)
    // Then nothing was published, nothing is held, and the next answerer decided
    expect(harness.transport.ofType('ev')).toEqual([])
    expect(harness.questions.size).toBe(0)
    expect(delegated).toBe(1)
    expect(outcome).toEqual({ answers: [] })
    // And the method it does not know is still an unknown method, as before
    await harness.connection.handleText(requestFrame(12, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    expect(answerOf(harness, 12).e).toEqual({ code: 'unknown-method', msg: 'unknown method question.answer' })
    expect(harness.gateway.invocations).toEqual([])
  })

  it('operator keeps one legacy phone on the wire while another declares the channel', async () => {
    // Given two paired phones, only one of which declared questions.v1
    const bare = makeBareHub()
    const declared = new RecordingTransport()
    const legacy = new RecordingTransport()
    const declaring = bare.hub.attach(declared, { deviceId: 'dev_declared' })
    const legacyConnection = bare.hub.attach(legacy, { deviceId: 'dev_legacy' })
    await declareQuestions(declaring)
    await legacyConnection.handleText(requestFrame(1, 'hello', { proto: 1 }))
    // When the host asks
    const pending = bare.hub.question(hostRequest(), desktopWaiting)
    // Then exactly the declaring phone was shown the question
    expect(questionPayloads(declared)).toHaveLength(1)
    expect(legacy.ofType('ev')).toEqual([])
    // And that phone's answer settled it
    await declaring.handleText(requestFrame(2, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    expect(await pending).toEqual(ANSWER)
  })

  it('operator a phone answers no question and the bridge holds it until the host decides', async () => {
    // Given a claimed question nobody answers
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const controller = new AbortController()
    const timeout = hostTimeout()
    const pending = harness.hub.question(hostRequest({ signal: controller.signal }), desktopWaiting)
    // When the host's own deadline elapses without any client timer of ours involved
    controller.abort(timeout)
    // Then the ask was released by the host's reason alone and the claim is still answerable
    await expect(pending).rejects.toBe(timeout)
    expect(harness.questions.stateOf('c-1')).toBe('continued')
  })

  it('operator cancels the agent turn and the claim is dropped instead of kept answerable', async () => {
    // Given a claimed question whose turn is cancelled
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const controller = new AbortController()
    const cancelled = Object.assign(new Error('the turn was cancelled'), { code: 'ASK_ABORTED' })
    const pending = harness.hub.question(hostRequest({ signal: controller.signal }), desktopWaiting)
    // When the turn's own lifetime ends
    controller.abort(cancelled)
    // Then the ask crosses back verbatim and nothing stays answerable
    await expect(pending).rejects.toBe(cancelled)
    expect(harness.questions.size).toBe(0)
    expect(questionPayloads(harness.transport).map(payload => payload.state)).toEqual(['open'])
  })

  it('operator loses the last phone and the claimed question is delegated', async () => {
    // Given a claimed question on a hub whose only phone is about to go away
    const harness = makeHub()
    await declareQuestions(harness.connection)
    // Here the desktop panel is what answers once the phone is gone, so it settles
    // rather than hanging: this case is about the hand-back, not about a race.
    const pending = harness.hub.question(hostRequest(), async () => ({ answers: [] }))
    // When the connection closes
    harness.hub.detach(harness.connection)
    // Then the question was handed to the next answerer rather than refused or left hanging
    expect(await pending).toEqual({ answers: [] })
    expect(harness.questions.size).toBe(0)
    expect(harness.logs).toContain('1 user question(s) released: no paired device is connected')
  })

  it('user answers a blocking ask and the phone was given a bridge-minted call id', async () => {
    // Given a blocking ask — the ask_user_question schema without a timeout, which
    // carries no wait and therefore no host call id at all
    const harness = makeHub({ questionIds: () => 'minted-1' })
    await declareQuestions(harness.connection)
    // When the host asks
    const pending = harness.hub.question(hostRequest({ wait: undefined }), desktopWaiting)
    // Then the phone is still shown the question, named by an id in the bridge's own namespace
    const payload = questionPayloads(harness.transport)[0]
    expect(payload).toMatchObject({ sessionId: 's-1', callId: 'bridge:minted-1', state: 'open' })
    expect(payload?.expiresAt).toBeUndefined()
    expect((payload?.questions as unknown[]).length).toBe(1)
    expect(harness.questions.stateOf('bridge:minted-1')).toBe('open')
    // When the user answers with that handle, the host's own ask is settled with it
    await harness.connection.handleText(requestFrame(20, 'question.answer', { sessionId: 's-1', callId: 'bridge:minted-1', answers: ANSWER.answers }))
    expect(answerOf(harness, 20)).toEqual({ ok: true, r: { ok: true } })
    expect(await pending).toEqual(ANSWER)
    // And a blocking question never needs the host's late-answer path
    expect(harness.gateway.invocations).toEqual([])
    expect(harness.questions.size).toBe(0)
  })

  it('user answers a minted call this bridge never issued and is refused as unknown', async () => {
    // Given a paired phone that announced the capability
    const harness = makeConnection({ paired: true, questionIds: () => 'minted-2' })
    await declareQuestions(harness.connection)
    // When it answers a bridge-looking id no claim ever carried
    await harness.connection.handleText(requestFrame(21, 'question.answer', { sessionId: 's-1', callId: 'bridge:minted-2', answers: ANSWER.answers }))
    // Then the prefix buys no trust: an id this bridge did not hold is unknown
    expect(answerOf(harness, 21).e?.code).toBe('question-unknown')
    expect(harness.gateway.invocations).toEqual([])
  })

  it('operator runs with no paired device and a blocking question is still delegated', async () => {
    // Given a hub whose only connection never paired
    const harness = makeHub({ paired: false, questionIds: () => 'minted-3' })
    let delegated = 0
    // When a blocking ask arrives
    const outcome = await harness.hub.question(hostRequest({ wait: undefined }), async () => {
      delegated += 1
      return { answers: [] }
    })
    // Then it is still the next answerer's, and no minted id was ever published
    expect(delegated).toBe(1)
    expect(outcome).toEqual({ answers: [] })
    expect(harness.transport.ofType('ev')).toEqual([])
    expect(harness.questions.size).toBe(0)
  })

  it('operator a minted id and a host call id never stand in for each other', async () => {
    // Given one blocking ask and one timed ask held at the same time
    const harness = makeHub({ questionIds: () => 'minted-4' })
    await declareQuestions(harness.connection)
    const blocking = harness.hub.question(hostRequest({ wait: undefined }), desktopWaiting)
    const timed = harness.hub.question(hostRequest(), desktopWaiting)
    // When the minted handle is answered
    await harness.connection.handleText(requestFrame(22, 'question.answer', { sessionId: 's-1', callId: 'bridge:minted-4', answers: ANSWER.answers }))
    // Then only the blocking ask settled, and the timed one is still open on its own id
    expect(await blocking).toEqual(ANSWER)
    expect(harness.questions.stateOf('c-1')).toBe('open')
    // When the host call id is answered
    await harness.connection.handleText(requestFrame(23, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    // Then only the timed ask settled
    expect(await timed).toEqual(ANSWER)
    expect(harness.questions.size).toBe(0)
  })

  it('operator a host ask that names no agent is never claimed', async () => {
    // Given a request with no agent, and so no session for the payload
    const harness = makeHub()
    await declareQuestions(harness.connection)
    let delegated = 0
    // When it arrives
    const outcome = await harness.hub.question(hostRequest({ agent: undefined }), async () => {
      delegated += 1
      return { answers: [] }
    })
    // Then it belongs to the next answerer and nothing was published or held
    expect(delegated).toBe(1)
    expect(outcome).toEqual({ answers: [] })
    expect(harness.questions.size).toBe(0)
    expect(harness.transport.ofType('ev')).toEqual([])
  })

  it('operator the desktop answers first and the phone is left with a refused tap', async () => {
    // Given a paired phone and a desktop panel, both looking at the same question
    const harness = makeHub()
    await declareQuestions(harness.connection)
    // When the desktop answers it first
    const outcome = await harness.hub.question(hostRequest(), async () => ANSWER)
    // Then the host took the desktop's answer, and the phone's claim is gone
    expect(outcome).toEqual(ANSWER)
    expect(harness.questions.size).toBe(0)
    // And the phone's late tap is refused rather than silently swallowed
    await harness.connection.handleText(requestFrame(2, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    expect(JSON.stringify(answerOf(harness, 2))).toContain('question-unknown')
  })

  it('operator the desktop gives up and the phone still answers', async () => {
    // Given a phone and a desktop answerer that fails immediately
    const harness = makeHub()
    await declareQuestions(harness.connection)
    const desktopFails = async (): Promise<QuestionAnswer> => {
      throw Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' })
    }
    const pending = harness.hub.question(hostRequest(), desktopFails)
    // When the phone answers, its answer is the one the host gets
    await harness.connection.handleText(requestFrame(2, 'question.answer', { sessionId: 's-1', callId: 'c-1', answers: ANSWER.answers }))
    expect(await pending).toEqual(ANSWER)
    expect(harness.questions.size).toBe(0)
  })
})
