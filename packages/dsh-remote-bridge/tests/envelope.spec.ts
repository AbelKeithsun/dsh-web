import { describe, expect, it } from 'vitest'
import { EventSequence, MAX_FRAME_BYTES, decodeClientFrame, encodeFrame, errorFrame, responseFrame, type ClientFrame } from '../src/core/envelope.ts'

function decoded(text: string): ClientFrame {
  const outcome = decodeClientFrame(text)
  if (!outcome.ok) throw new Error(`expected a decodable frame, got ${outcome.code}: ${outcome.msg}`)
  return outcome.frame
}

function refusalOf(text: string): { id: number; code: string } {
  const outcome = decodeClientFrame(text)
  if (outcome.ok) throw new Error(`expected a refusal, got ${outcome.frame.t}`)
  return { id: outcome.id, code: outcome.code }
}

describe('protocol v1 envelope', () => {
  it('user sends a request frame and the bridge reads its method, id and payload', () => {
    // Given a well-formed request frame carrying an empty payload
    const text = JSON.stringify({ t: 'req', id: 7, m: 'session.list', p: {} })
    // When the bridge decodes it
    const frame = decoded(text)
    // Then the method, the correlating id and the payload survive the round trip
    expect(frame).toEqual({ t: 'req', id: 7, m: 'session.list', p: {} })
  })

  it('user omits the payload key and the bridge treats the request as having no arguments', () => {
    // Given a request frame that carries no p member at all
    const text = JSON.stringify({ t: 'req', id: 1, m: 'hello' })
    // When the bridge decodes it
    const frame = decoded(text)
    // Then the payload defaults to an empty object instead of failing the frame
    expect(frame).toEqual({ t: 'req', id: 1, m: 'hello', p: {} })
  })

  it('user sends a heartbeat and the bridge keeps its timestamp', () => {
    // Given a ping frame carrying the client's clock
    const text = JSON.stringify({ t: 'ping', ts: 1735689600000 })
    // When the bridge decodes it
    const frame = decoded(text)
    // Then the timestamp is preserved for an echo back
    expect(frame).toEqual({ t: 'ping', ts: 1735689600000 })
  })

  it('user sends bytes that are not JSON and the bridge answers on the reserved id', () => {
    // Given a frame body that is not JSON at all
    // When the bridge decodes it
    const refusal = refusalOf('not-json{')
    // Then the refusal is a malformed frame, answerable only on the reserved id 0
    expect(refusal).toEqual({ id: 0, code: 'malformed' })
  })

  it('user sends a frame body that is JSON but not an object and the bridge refuses it', () => {
    // Given a frame body that parses to a JSON array
    // When the bridge decodes it
    const refusal = refusalOf('[1,2,3]')
    // Then the frame is rejected as malformed rather than coerced
    expect(refusal).toEqual({ id: 0, code: 'malformed' })
  })

  it('user sends a response frame and the bridge names the direction violation', () => {
    // Given a res frame, which only a server may send
    const text = JSON.stringify({ t: 'res', id: 4, ok: true, r: {} })
    // When the bridge decodes it
    const refusal = refusalOf(text)
    // Then the failure says the half of the protocol is wrong, not that the JSON is
    expect(refusal).toEqual({ id: 4, code: 'direction-violation' })
  })

  it('user sends a request without an id and the bridge refuses it on the reserved id', () => {
    // Given a request frame whose id is missing
    const text = JSON.stringify({ t: 'req', m: 'hello', p: {} })
    // When the bridge decodes it
    const refusal = refusalOf(text)
    // Then no response can be correlated, so the reserved id carries the refusal
    expect(refusal).toEqual({ id: 0, code: 'malformed' })
  })

  it('user sends a request with a negative id and the bridge refuses it', () => {
    // Given a request frame whose id is not a non-negative integer
    const text = JSON.stringify({ t: 'req', id: -1, m: 'hello', p: {} })
    // When the bridge decodes it
    const refusal = refusalOf(text)
    // Then the frame is refused before any method runs
    expect(refusal).toEqual({ id: 0, code: 'malformed' })
  })

  it('user sends a frame past the byte cap and the bridge refuses it before parsing', () => {
    // Given a request frame whose UTF-8 length exceeds one frame's budget
    const text = JSON.stringify({ t: 'req', id: 9, m: 'session.prompt', p: { text: 'x'.repeat(MAX_FRAME_BYTES + 16) } })
    // When the bridge decodes it
    const refusal = refusalOf(text)
    // Then the refusal is the size rule, decided without allocating a parsed graph
    expect(refusal).toEqual({ id: 0, code: 'frame-too-large' })
  })

  it('operator sees one connection sequence counting events from one upward', () => {
    // Given a fresh per-connection sequence
    const sequence = new EventSequence()
    // When three events take a number
    const taken = [sequence.take(), sequence.take(), sequence.take()]
    // Then the numbers are dense and monotonic from 1, and the next one is known without advancing
    expect(taken).toEqual([1, 2, 3])
    expect(sequence.peek()).toBe(4)
  })

  it('user receives a success envelope and a failure envelope in the frozen shapes', () => {
    // Given one result and one refusal
    const success = responseFrame(3, { accepted: true })
    const failure = errorFrame(3, 'unpaired', 'this connection is not paired')
    // When both are serialized
    const wire = [encodeFrame(success), encodeFrame(failure)].map(text => JSON.parse(text) as unknown)
    // Then each carries exactly the frozen members
    expect(wire).toEqual([
      { t: 'res', id: 3, ok: true, r: { accepted: true } },
      { t: 'res', id: 3, ok: false, e: { code: 'unpaired', msg: 'this connection is not paired' } },
    ])
  })
})
