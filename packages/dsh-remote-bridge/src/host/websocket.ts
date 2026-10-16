/**
 * The WebSocket carrier of `/ios/v1`: RFC 6455 negotiation plus the frame loop.
 *
 * This is the only WebSocket in the family that terminates the protocol
 * itself — the other remote plugin proxies its upgrades to the host mux — so
 * the framing rules are implemented here against `core/ws-frames.ts` and every
 * socket failure funnels into one teardown path that the hub observes exactly
 * once.
 * @module dsh-remote-bridge/host/websocket
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { BridgeTransport } from '../core/connection.ts'
import { MAX_FRAME_BYTES } from '../core/envelope.ts'
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_TOO_LARGE,
  CLOSE_UNSUPPORTED_DATA,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_CONTINUATION,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  encodeCloseFrame,
  encodeServerFrame,
  encodeTextFrame,
  parseClientFrame,
  webSocketAccept,
} from '../core/ws-frames.ts'

/** Close code a well-behaved peer sends when it goes away. */
const CLOSE_NORMAL = 1000

/** @returns whether this request asks for a WebSocket upgrade. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket'
}

/** @returns the client's `Sec-WebSocket-Key`, or undefined when the handshake is incomplete. */
export function readSecWebSocketKey(req: IncomingMessage): string | undefined {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string') return undefined
  const trimmed = key.trim()
  return trimmed === '' ? undefined : trimmed
}

/** @returns the device token on `Authorization: Bearer …`, if the client sent one. */
export function bearerTokenOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const value = match?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * @returns the token on `?token=…`, the fallback for clients whose handshake
 *   cannot set a header (share sheets, `wscat`, plain scripts).
 */
export function queryTokenOf(requestUrl: string | undefined): string | undefined {
  if (requestUrl === undefined || requestUrl === '') return undefined
  let value: string | null
  try {
    value = new URL(requestUrl, 'http://127.0.0.1').searchParams.get('token')
  } catch {
    return undefined
  }
  return value === null || value === '' ? undefined : value
}

/**
 * @returns the token this upgrade presents: the header first, then the query.
 *   A bootstrap token presented here is simply not a device token, which leaves
 *   the connection unpaired — the state `pair.begin` needs.
 */
export function presentedTokenOf(req: IncomingMessage): string | undefined {
  return bearerTokenOf(req) ?? queryTokenOf(req.url)
}

/** Answer an upgrade this endpoint will not take, and close the socket. */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  socket.destroy()
}

/**
 * One accepted socket, framed.
 *
 * Frames are buffered until a whole one has arrived; a fragmented message is
 * reassembled up to {@link MAX_FRAME_BYTES} and anything larger closes the
 * socket with the code that names the violation. The carrier is inert until
 * {@link handshake} runs, so a caller can refuse a connection without having
 * written a byte of the protocol.
 */
export class WebSocketCarrier implements BridgeTransport {
  readonly #socket: Duplex
  #buffer: Buffer = Buffer.alloc(0)
  #fragments: Buffer[] = []
  #fragmentOpcode = 0
  #fragmentBytes = 0
  #opened = false
  #closed = false
  #onMessage: ((text: string) => void) | undefined
  #onClose: (() => void) | undefined

  constructor(socket: Duplex) {
    this.#socket = socket
    socket.on('error', () => { this.#shut() })
    socket.on('close', () => { this.#shut() })
    socket.on('end', () => { this.#shut() })
  }

  /** Write the 101 handshake carrying the accept value for the client's key. */
  handshake(secWebSocketKey: string): void {
    if (this.#opened || this.#closed) return
    this.#opened = true
    this.#socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'upgrade: websocket',
      'connection: Upgrade',
      `sec-websocket-accept: ${webSocketAccept(secWebSocketKey)}`,
      '',
      '',
    ].join('\r\n'))
  }

  /** Register the handler for every complete text message. */
  onMessage(handler: (text: string) => void): void {
    this.#onMessage = handler
  }

  /** Register the one teardown hook; it runs exactly once. */
  onClose(handler: () => void): void {
    this.#onClose = handler
  }

  /** Feed raw bytes from the socket into the frame loop. */
  feed(chunk: Buffer): void {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const outcome = parseClientFrame(this.#buffer, MAX_FRAME_BYTES)
      if (outcome.status === 'incomplete') return
      if (outcome.status === 'fault') {
        this.close(outcome.closeCode, outcome.reason)
        return
      }
      this.#buffer = this.#buffer.subarray(outcome.frame.consumed)
      if (!this.#accept(outcome.frame.fin, outcome.frame.opcode, outcome.frame.payload)) return
    }
  }

  /** Send one text frame. */
  send(text: string): void {
    if (this.#closed) return
    this.#socket.write(encodeTextFrame(text))
  }

  /** Send a close frame and end the socket. Idempotent. */
  close(code: number, reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#socket.write(encodeCloseFrame(code, reason))
    this.#socket.end()
    this.#notifyClose()
  }

  /** @returns whether the carrier has been torn down. */
  get closed(): boolean {
    return this.#closed
  }

  #accept(fin: boolean, opcode: number, payload: Buffer): boolean {
    switch (opcode) {
      case OPCODE_TEXT:
      case OPCODE_BINARY: {
        if (this.#fragmentOpcode !== 0) {
          this.close(CLOSE_PROTOCOL_ERROR, 'a new message started before the previous one finished')
          return false
        }
        if (fin) return this.#deliver(opcode, payload)
        this.#fragmentOpcode = opcode
        this.#fragments = [payload]
        this.#fragmentBytes = payload.length
        return true
      }
      case OPCODE_CONTINUATION: {
        if (this.#fragmentOpcode === 0) {
          this.close(CLOSE_PROTOCOL_ERROR, 'continuation frame without a started message')
          return false
        }
        this.#fragmentBytes += payload.length
        if (this.#fragmentBytes > MAX_FRAME_BYTES) {
          this.close(CLOSE_TOO_LARGE, `a message may not exceed ${MAX_FRAME_BYTES} bytes`)
          return false
        }
        this.#fragments.push(payload)
        if (!fin) return true
        const message = Buffer.concat(this.#fragments, this.#fragmentBytes)
        const opcodeOfMessage = this.#fragmentOpcode
        this.#fragments = []
        this.#fragmentBytes = 0
        this.#fragmentOpcode = 0
        return this.#deliver(opcodeOfMessage, message)
      }
      case OPCODE_PING:
        this.#socket.write(encodeServerFrame(OPCODE_PONG, payload))
        return true
      case OPCODE_PONG:
        return true
      case OPCODE_CLOSE:
        this.close(CLOSE_NORMAL, '')
        return false
      default:
        this.close(CLOSE_PROTOCOL_ERROR, `unsupported opcode ${opcode}`)
        return false
    }
  }

  #deliver(opcode: number, payload: Buffer): boolean {
    if (opcode !== OPCODE_TEXT) {
      this.close(CLOSE_UNSUPPORTED_DATA, 'this endpoint carries text frames only')
      return false
    }
    this.#onMessage?.(payload.toString('utf8'))
    return true
  }

  /** The socket went away without a close frame: tear down without writing. */
  #shut(): void {
    if (this.#closed) return
    this.#closed = true
    this.#notifyClose()
  }

  #notifyClose(): void {
    const handler = this.#onClose
    this.#onClose = undefined
    handler?.()
  }
}
