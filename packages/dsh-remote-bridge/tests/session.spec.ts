import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControllableStream, answerOf, makeConnection, requestFrame, settle } from './support/harness.ts'

/** One follow record as DSH writes it. */
function record(type: string, seq: number, time: number, data: unknown): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

/** One assistant-stream chunk frame. */
function chunk(index: number, body: unknown): unknown {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a-1', revision: 1, index, time: 10 + index, chunk: body } }
}

describe('session methods over protocol v1', () => {
  afterEach(() => { vi.useRealTimers() })

  it('user opens a session and the snapshot arrives with its turns and durable cursor', async () => {
    // Given a host whose follow stream opens with a completed turn
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(1, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({
      type: 'snapshot',
      header: { version: 1, id: 's-1', createdAt: 1, isSeeded: false },
      cursor: 42,
      hasMore: false,
      projections: {},
      records: [
        record('turn/start', 1, 100, { turn: 1 }),
        record('user/message', 2, 101, { content: 'hi' }),
        record('turn/end', 3, 102, { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    // When the user asks for the snapshot
    await pending
    // Then the turns are grouped from turn start to turn end and the cursor crosses as lastSeq
    const answer = answerOf(harness, 1)
    const payload = answer.r as { turns: { seq: number; endSeq: number; reason: string; entries: unknown[] }[]; lastSeq: number }
    expect(payload.lastSeq).toBe(42)
    expect(payload.turns).toHaveLength(1)
    expect(payload.turns[0]?.seq).toBe(1)
    expect(payload.turns[0]?.endSeq).toBe(3)
    expect(payload.turns[0]?.reason).toBe('completed')
    expect(payload.turns[0]?.entries).toHaveLength(3)
  })

  it('user opens a session and the follow stream is asked for process-local deltas', async () => {
    // Given a host whose follow stream opens with an empty baseline
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(2, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    // When the snapshot is answered
    await pending
    // Then the stream was opened through the plain request key with the assistant stream switched on
    expect(harness.gateway.streamRequests).toHaveLength(1)
    expect(harness.gateway.streamRequests[0]?.args).toEqual({
      request: { address: { kind: 'session', sessionId: 's-1' }, assistantStream: true, maxMessages: 200 },
    })
  })

  it('user asking twice for the same session reuses the one follow stream', async () => {
    // Given a session already subscribed
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const first = harness.connection.handleText(requestFrame(3, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 7, hasMore: false, projections: {}, records: [] })
    await first
    // When the user snapshots again
    await harness.connection.handleText(requestFrame(4, 'session.snapshot', { sessionId: 's-1' }))
    // Then the same stream answered and no second one was opened
    expect(harness.gateway.streamRequests).toHaveLength(1)
    expect((answerOf(harness, 4).r as { lastSeq: number }).lastSeq).toBe(7)
  })

  it('user sees assistant text, reasoning and tool arguments as increments', async () => {
    // Given a subscribed session
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(5, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When the assistant streams text, reasoning and a call whose arguments arrive in two pieces
    follow.push(chunk(0, { type: 'text-delta', index: 0, text: 'Hel' }))
    follow.push(chunk(1, { type: 'reasoning-delta', index: 1, text: 'because' }))
    follow.push(chunk(2, { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'bash', argumentsDelta: '{"cmd"' }))
    follow.push(chunk(3, { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: ':1}' }))
    await settle()
    // Then each increment is published as its own delta, and the argument pieces concatenate
    const events = harness.transport.ofType('ev').filter(frame => frame.m === 'session.delta')
    expect(events.map(frame => (frame.p as { kind: string }).kind)).toEqual(['text', 'reasoning', 'tool-call', 'tool-call'])
    expect(events[0]?.p).toEqual({ sessionId: 's-1', kind: 'text', text: 'Hel', blockIndex: 0 })
    expect(events[1]?.p).toEqual({ sessionId: 's-1', kind: 'reasoning', text: 'because', blockIndex: 1 })
    const concatenated = events
      .filter(frame => (frame.p as { kind: string }).kind === 'tool-call')
      .map(frame => (frame.p as { argumentsDelta: string }).argumentsDelta)
      .join('')
    expect(concatenated).toBe('{"cmd":1}')
    expect(events[3]?.p).toEqual({ sessionId: 's-1', kind: 'tool-call', callId: 'call-1', name: 'bash', argumentsDelta: ':1}' })
  })

  it('user sees a tool result and the end of the turn as their own deltas', async () => {
    // Given a subscribed session
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(6, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When a tool result and a failed turn end arrive
    follow.push(record('tool/result', 11, 200, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'exit 1' }], isError: true } }))
    follow.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'error' } }))
    await settle()
    // Then the result carries its call, output and failure flag, and the turn end carries only its reason
    const events = harness.transport.ofType('ev').filter(frame => frame.m === 'session.delta')
    expect(events[0]?.p).toEqual({ sessionId: 's-1', kind: 'tool-result', callId: 'call-1', output: 'exit 1', isError: true })
    expect(events[1]?.p).toEqual({ sessionId: 's-1', kind: 'turn-end', reason: 'error' })
    expect(events.map(frame => frame.seq)).toEqual([1, 2])
  })

  it('user who already streamed a call does not receive its arguments a second time', async () => {
    // Given a subscribed session that streamed one call's arguments
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(7, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    follow.push(chunk(0, { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'bash', argumentsDelta: '{}' }))
    await settle()
    // When the durable tool call event for that same call arrives
    follow.push(record('tool/call', 12, 202, { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{}' }))
    await settle()
    // Then only the increment was published, because the durable event would duplicate it
    const toolCalls = harness.transport.ofType('ev').filter(frame => (frame.p as { kind?: string }).kind === 'tool-call')
    expect(toolCalls).toHaveLength(1)
  })

  it('user who subscribed after a call started receives its assembled arguments once', async () => {
    // Given a subscribed session with no streamed arguments for the call
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(8, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When the durable tool call event arrives
    follow.push(record('tool/call', 12, 202, { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{"a":1}' }))
    await settle()
    // Then the whole argument string crosses as one increment
    const toolCalls = harness.transport.ofType('ev').filter(frame => (frame.p as { kind?: string }).kind === 'tool-call')
    expect(toolCalls.map(frame => frame.p)).toEqual([
      { sessionId: 's-1', kind: 'tool-call', callId: 'call-9', name: 'bash', argumentsDelta: '{"a":1}' },
    ])
  })

  it('user prompting a session sends one queued text message with this machine time zone', async () => {
    // Given a paired connection and a host that accepts prompts
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = call => new ControllableStream().attach(call.signal).iterable()
    // When the user prompts
    await harness.connection.handleText(requestFrame(9, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // Then the message rides the request key with the queue mode and the resolved time zone
    expect(answerOf(harness, 9).r).toEqual({ accepted: true })
    expect(harness.gateway.lastArgs('session', 'prompt')).toEqual({
      request: {
        requestId: 'r-1',
        sessionId: 's-1',
        mode: 'queue',
        content: [{ type: 'text', text: 'hello' }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
  })

  it('user repeating a prompt with the same request id is not sent twice', async () => {
    // Given a connection that already sent one prompt
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = call => new ControllableStream().attach(call.signal).iterable()
    await harness.connection.handleText(requestFrame(10, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // When the same request id is sent again
    await harness.connection.handleText(requestFrame(11, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // Then the host saw one prompt and the retry is acknowledged
    expect(harness.gateway.countOf('session', 'prompt')).toBe(1)
    expect(answerOf(harness, 11).r).toEqual({ accepted: true })
  })

  it('user repeating a prompt after a failed send is allowed to retry', async () => {
    // Given a host that fails the first prompt outright
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = call => new ControllableStream().attach(call.signal).iterable()
    let attempts = 0
    harness.gateway.handler = async () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('gateway is not serving prompts'), { code: 'gateway/invocation-unavailable' })
      return { accepted: true }
    }
    await harness.connection.handleText(requestFrame(12, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // When the client retries the same request id
    await harness.connection.handleText(requestFrame(13, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // Then the failure crossed as the gateway's own code and the retry reached the host
    expect(answerOf(harness, 12).e?.code).toBe('gateway/invocation-unavailable')
    expect(answerOf(harness, 13).r).toEqual({ accepted: true })
    expect(harness.gateway.countOf('session', 'prompt')).toBe(2)
  })

  it('user interrupting a session cancels the turn and keeps the subscription', async () => {
    // Given a subscribed session
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(14, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When the user interrupts the turn
    await harness.connection.handleText(requestFrame(15, 'session.interrupt', { sessionId: 's-1' }))
    // Then the cancel rides the request key and the follow stream is still live
    expect(answerOf(harness, 15).r).toEqual({ ok: true })
    expect(harness.gateway.lastArgs('session', 'cancel')).toEqual({ request: { sessionId: 's-1' } })
    expect(follow.aborted).toBe(false)
  })

  it('operator sees every follow stream aborted when the connection closes', async () => {
    // Given a connection subscribed to two sessions
    const harness = makeConnection({ paired: true })
    const first = new ControllableStream()
    const second = new ControllableStream()
    harness.gateway.follow = call => {
      const sessionId = (call.args.request as { address: { sessionId: string } }).address.sessionId
      return (sessionId === 's-1' ? first : second).attach(call.signal).iterable()
    }
    const one = harness.connection.handleText(requestFrame(16, 'session.snapshot', { sessionId: 's-1' }))
    first.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await one
    const two = harness.connection.handleText(requestFrame(17, 'session.snapshot', { sessionId: 's-2' }))
    second.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await two
    // When the connection is torn down
    harness.connection.dispose()
    // Then every stream it owned was aborted and no session is left subscribed
    expect([first.aborted, second.aborted]).toEqual([true, true])
  })

  it('user snapshotting a session whose stream never opens is told the snapshot is unavailable', async () => {
    // Given a host whose follow stream ends without its opening frame
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(18, 'session.snapshot', { sessionId: 's-1' }))
    follow.end()
    // When the snapshot is awaited
    await pending
    // Then the refusal names the missing baseline, and the dead subscription is dropped
    expect(answerOf(harness, 18).e?.code).toBe('snapshot-unavailable')
    const retry = harness.connection.handleText(requestFrame(19, 'session.snapshot', { sessionId: 's-1' }))
    const reopened = new ControllableStream()
    harness.gateway.follow = call => reopened.attach(call.signal).iterable()
    reopened.push({ type: 'snapshot', header: {}, cursor: 3, hasMore: false, projections: {}, records: [] })
    await retry
    expect(harness.gateway.streamRequests).toHaveLength(2)
  })

  it('user snapshotting a session larger than one frame is refused rather than truncated silently', async () => {
    // Given a session whose single recorded turn is larger than one frame may carry
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(20, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({
      type: 'snapshot',
      header: {},
      cursor: 1,
      hasMore: false,
      projections: {},
      records: [
        record('turn/start', 1, 100, { turn: 1 }),
        record('user/message', 2, 101, { text: 'x'.repeat(300 * 1024) }),
      ],
    })
    // When the snapshot is awaited
    await pending
    // Then the refusal says the snapshot does not fit, instead of sending a clipped history
    expect(answerOf(harness, 20).e?.code).toBe('snapshot-too-large')
  })

  it('user listing sessions while the host is still activating is retried instead of failed', async () => {
    // Given a gateway that refuses four times while its session service activates
    vi.useFakeTimers()
    const harness = makeConnection({ paired: true })
    let attempts = 0
    harness.gateway.handler = async () => {
      attempts += 1
      if (attempts < 5) throw Object.assign(new Error('service is activating'), { code: 'gateway/service-unavailable' })
      return { items: [{ sessionId: 's-1', updatedAt: 1, running: true, blank: false, agentAvailable: true }] }
    }
    // When the user lists sessions
    const pending = harness.connection.handleText(requestFrame(21, 'session.list'))
    await vi.advanceTimersByTimeAsync(8_000)
    await pending
    // Then the fifth try answered and the roster crossed
    expect(attempts).toBe(5)
    expect(answerOf(harness, 21).r).toEqual({ sessions: [{ id: 's-1', title: '', updatedAt: 1, agentRunning: true, blank: false }] })
  })

  it('operator prompts a session whose stream cannot open and the connection stays usable', async () => {
    // Given a host that refuses to open any follow stream
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = () => { throw new Error('session service refuses follow') }
    // When the user prompts without snapshotting first, so nothing ever awaits that stream
    await harness.connection.handleText(requestFrame(22, 'session.prompt', { sessionId: 's-1', text: 'hi', requestId: 'r-9' }))
    await settle()
    // Then the prompt itself answered and the socket is still answering afterwards
    expect(answerOf(harness, 22).r).toEqual({ accepted: true })
    await harness.connection.handleText(requestFrame(23, 'hello', { proto: 1 }))
    expect(answerOf(harness, 23).ok).toBe(true)
  })
})
