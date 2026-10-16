import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { nextTurn } from './support/harness.ts'
import { describe, expect, it } from 'vitest'
import { OPCODE_BINARY, OPCODE_CLOSE, OPCODE_TEXT } from '../src/core/ws-frames.ts'
import { WebSocketCarrier, bearerTokenOf, isWebSocketUpgrade, presentedTokenOf, queryTokenOf } from '../src/host/websocket.ts'

const HANDSHAKE_END = Buffer.from('\r\n\r\n')

/** One masked client frame, as a browser or iOS client sends it. */
function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x5a, 0x6b, 0x7c, 0x8d])
  const masked = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)))
  const header = payload.length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, mask, masked])
}

/** One unmasked server frame read back off the wire. */
interface ServerFrame {
  readonly opcode: number
  readonly payload: Buffer
}

/** A socket pair standing in for the upgraded connection, handshake already written. */
function openCarrier(): { carrier: WebSocketCarrier; socket: PassThrough; bytes: () => Buffer } {
  const socket = new PassThrough()
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  const carrier = new WebSocketCarrier(socket)
  carrier.handshake('dGhlIHNhbXBsZSBub25jZQ==')
  return { carrier, socket, bytes: () => Buffer.concat(chunks) }
}

/** Everything written before the handshake finished. */
function handshakeOf(bytes: Buffer): string {
  return bytes.subarray(0, bytes.indexOf(HANDSHAKE_END) + HANDSHAKE_END.length).toString('latin1')
}

/** Every unmasked server frame written after the handshake. */
function serverFrames(bytes: Buffer): ServerFrame[] {
  let rest = bytes.subarray(bytes.indexOf(HANDSHAKE_END) + HANDSHAKE_END.length)
  const frames: ServerFrame[] = []
  while (rest.length >= 2) {
    const opcode = (rest[0] ?? 0) & 0x0f
    let length = rest[1] ?? 0
    let offset = 2
    if (length === 126) {
      length = rest.readUInt16BE(2)
      offset = 4
    }
    frames.push({ opcode, payload: rest.subarray(offset, offset + length) })
    rest = rest.subarray(offset + length)
  }
  return frames
}

/** A request stub whose handshake fields the test chooses. */
function fakeRequest(headers: Record<string, string>, url = '/ios/v1'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage
}

describe('WebSocket carrier', () => {
  it('user completes the handshake and the response carries the derived accept value', () => {
    // Given a carrier over a freshly accepted socket
    const { carrier, bytes } = openCarrier()
    // When the handshake is written for a client key
    carrier.handshake('dGhlIHNhbXBsZSBub25jZQ==')
    // Then the response is a switching-protocols answer naming the accept value from the specification
    const response = handshakeOf(bytes())
    expect(response.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true)
    expect(response.includes('sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')).toBe(true)
  })

  it('user sends a text message and it reaches the connection handler', () => {
    // Given a carrier with a message handler
    const { carrier } = openCarrier()
    const messages: string[] = []
    carrier.onMessage(text => { messages.push(text) })
    // When a masked text frame arrives
    carrier.feed(maskedFrame(OPCODE_TEXT, Buffer.from('{"t":"req","id":1,"m":"hello"}')))
    // Then the handler saw exactly that text
    expect(messages).toEqual(['{"t":"req","id":1,"m":"hello"}'])
  })

  it('user sends two frames in one read and both reach the handler in order', () => {
    // Given a carrier with a message handler
    const { carrier } = openCarrier()
    const messages: string[] = []
    carrier.onMessage(text => { messages.push(text) })
    // When a single chunk carries two frames
    carrier.feed(Buffer.concat([
      maskedFrame(OPCODE_TEXT, Buffer.from('one')),
      maskedFrame(OPCODE_TEXT, Buffer.from('two')),
    ]))
    // Then the frame loop consumed both
    expect(messages).toEqual(['one', 'two'])
  })

  it('user sends a binary frame and the socket is closed as unsupported data', () => {
    // Given a carrier over a socket
    const { carrier, bytes } = openCarrier()
    // When a binary frame arrives
    carrier.feed(maskedFrame(OPCODE_BINARY, Buffer.from([1, 2, 3])))
    // Then the peer is told which rule it broke
    const frames = serverFrames(bytes())
    expect(frames.map(frame => frame.opcode)).toEqual([OPCODE_CLOSE])
    expect(frames[0]?.payload.readUInt16BE(0)).toBe(1003)
    expect(carrier.closed).toBe(true)
  })

  it('user sends an unmasked frame and the carrier closes the socket exactly once', () => {
    // Given a carrier with a teardown hook
    const { carrier, bytes } = openCarrier()
    let closes = 0
    carrier.onClose(() => { closes += 1 })
    // When an unmasked frame arrives and the carrier is then closed again
    carrier.feed(Buffer.from([0x81, 0x02, 0x68, 0x69]))
    carrier.close(1000, '')
    // Then the peer was told it broke the protocol and the hook ran once
    expect(serverFrames(bytes())[0]?.payload.readUInt16BE(0)).toBe(1002)
    expect(closes).toBe(1)
  })

  it('operator drops the socket and the teardown hook runs once', async () => {
    // Given a carrier over a socket
    const { carrier, socket } = openCarrier()
    let closes = 0
    carrier.onClose(() => { closes += 1 })
    // When the socket goes away underneath it
    socket.destroy()
    await nextTurn()
    // Then the connection is torn down exactly once
    expect(closes).toBe(1)
    expect(carrier.closed).toBe(true)
  })

  it('user sends a close frame and the session ends without an error code', () => {
    // Given a carrier over a socket
    const { carrier, bytes } = openCarrier()
    let closes = 0
    carrier.onClose(() => { closes += 1 })
    // When the client closes normally
    carrier.feed(maskedFrame(OPCODE_CLOSE, Buffer.alloc(0)))
    // Then the carrier echoes a normal close and nothing else will be delivered
    expect(serverFrames(bytes())[0]?.payload.readUInt16BE(0)).toBe(1000)
    expect(closes).toBe(1)
  })

  it('user sends a message after the carrier closed and it is ignored', () => {
    // Given a carrier that has already been closed
    const { carrier } = openCarrier()
    const messages: string[] = []
    carrier.onMessage(text => { messages.push(text) })
    carrier.close(1000, '')
    // When a late frame arrives
    carrier.feed(maskedFrame(OPCODE_TEXT, Buffer.from('too late')))
    // Then it is dropped instead of reaching a connection that is gone
    expect(messages).toEqual([])
  })

  it('operator reads the token from the header first and the query second', () => {
    // Given an upgrade carrying both forms, one carrying only the query, and one carrying neither
    const both = fakeRequest({ authorization: 'Bearer from-header' }, '/ios/v1?token=from-query')
    const queryOnly = fakeRequest({}, '/ios/v1?token=from-query')
    const neither = fakeRequest({})
    // When each token is resolved
    const resolved = [both, queryOnly, neither].map(request => presentedTokenOf(request))
    // Then the header wins, the query is the fallback, and no token means unpaired
    expect(resolved).toEqual(['from-header', 'from-query', undefined])
    expect(bearerTokenOf(both)).toBe('from-header')
    expect(queryTokenOf(neither.url)).toBeUndefined()
  })

  it('operator inspects an upgrade request and only a WebSocket upgrade is accepted', () => {
    // Given one request that upgrades and one plain request
    const upgrading = fakeRequest({ upgrade: 'websocket' })
    const plain = fakeRequest({})
    // When the upgrade header is read
    const verdicts = [upgrading, plain].map(request => isWebSocketUpgrade(request))
    // Then only the WebSocket upgrade passes
    expect(verdicts).toEqual([true, false])
  })
})
