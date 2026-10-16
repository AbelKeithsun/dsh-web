/**
 * Protocol v1 frame envelope: the one JSON-object-per-text-frame codec both
 * ends of the bridge speak. Shapes are frozen by the parent card and are not
 * ours to extend:
 *
 *   request   {"t":"req","id":<uint>,"m":"<method>","p":{...}}
 *   response  {"t":"res","id":<uint>,"ok":true,"r":{...}}
 *             {"t":"res","id":<uint>,"ok":false,"e":{"code":"<str>","msg":"<str>"}}
 *   event     {"t":"ev","seq":<uint>,"m":"<topic>","p":{...}}
 *   heartbeat {"t":"ping","ts":<ms>} / {"t":"pong","ts":<ms>}
 *
 * Decisions this module owns (not restated by the frozen design):
 * - the 256 KiB cap is measured in UTF-8 bytes of the received text, before
 *   parsing, so an oversized frame never allocates a parsed object graph;
 * - direction violations (a `res` or `ev` arriving FROM the client) are their
 *   own failure code instead of `malformed`, because "the peer is speaking the
 *   wrong half of the protocol" is an actionable diagnostic;
 * - a frame whose identity cannot be recovered is answered with the reserved
 *   id 0, since the envelope has no way to decline answering.
 * @module dsh-remote-bridge/core/envelope
 */

/** Largest single text frame either direction may carry, in UTF-8 bytes. */
export const MAX_FRAME_BYTES = 256 * 1024

/** Reserved response id for a frame whose own id could not be recovered. */
export const UNIDENTIFIED_FRAME_ID = 0

export interface ReqFrame {
  readonly t: 'req'
  readonly id: number
  readonly m: string
  readonly p: Readonly<Record<string, unknown>>
}

export interface PingFrame {
  readonly t: 'ping'
  readonly ts: number
}

export interface PongFrame {
  readonly t: 'pong'
  readonly ts: number
}

/** Every frame a client may legitimately send. */
export type ClientFrame = ReqFrame | PingFrame | PongFrame

export interface ResFrame {
  readonly t: 'res'
  readonly id: number
  readonly ok: boolean
  readonly r?: unknown
  readonly e?: { readonly code: string; readonly msg: string }
}

export interface EvFrame {
  readonly t: 'ev'
  readonly seq: number
  readonly m: string
  readonly p: unknown
}

export type ServerFrame = ResFrame | EvFrame | PingFrame | PongFrame

/** One refusal the decoder can state about the bytes it was handed. */
export interface FrameFailure {
  readonly ok: false
  /** Response id to answer on: the recovered request id, else {@link UNIDENTIFIED_FRAME_ID}. */
  readonly id: number
  readonly code: string
  readonly msg: string
}

export type DecodeOutcome = { readonly ok: true; readonly frame: ClientFrame } | FrameFailure

/** Failure codes the codec itself raises. */
export const FRAME_TOO_LARGE = 'frame-too-large'
export const MALFORMED_FRAME = 'malformed'
export const DIRECTION_VIOLATION = 'direction-violation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An envelope id is a non-negative safe integer. */
function isFrameId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Decode one received text frame.
 * @param text - the frame body exactly as it crossed the wire.
 * @returns the frame, or the refusal to answer with.
 */
export function decodeClientFrame(text: string): DecodeOutcome {
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
    return { ok: false, id: UNIDENTIFIED_FRAME_ID, code: FRAME_TOO_LARGE, msg: `frame exceeds ${MAX_FRAME_BYTES} bytes` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, id: UNIDENTIFIED_FRAME_ID, code: MALFORMED_FRAME, msg: 'frame is not JSON' }
  }
  if (!isRecord(parsed)) {
    return { ok: false, id: UNIDENTIFIED_FRAME_ID, code: MALFORMED_FRAME, msg: 'frame is not a JSON object' }
  }
  const kind = parsed.t
  if (kind === 'ping' || kind === 'pong') {
    if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) {
      return { ok: false, id: UNIDENTIFIED_FRAME_ID, code: MALFORMED_FRAME, msg: `${kind} requires a numeric ts` }
    }
    return { ok: true, frame: { t: kind, ts: parsed.ts } }
  }
  if (kind === 'res' || kind === 'ev') {
    return {
      ok: false,
      id: isFrameId(parsed.id) ? parsed.id : UNIDENTIFIED_FRAME_ID,
      code: DIRECTION_VIOLATION,
      msg: `a client must not send a ${kind} frame`,
    }
  }
  if (kind !== 'req') {
    return { ok: false, id: UNIDENTIFIED_FRAME_ID, code: MALFORMED_FRAME, msg: 'frame has no known t discriminator' }
  }
  if (!isFrameId(parsed.id)) {
    return { ok: false, id: UNIDENTIFIED_FRAME_ID, code: MALFORMED_FRAME, msg: 'req requires a non-negative integer id' }
  }
  if (typeof parsed.m !== 'string' || parsed.m === '') {
    return { ok: false, id: parsed.id, code: MALFORMED_FRAME, msg: 'req requires a method name' }
  }
  if (parsed.p !== undefined && !isRecord(parsed.p)) {
    return { ok: false, id: parsed.id, code: MALFORMED_FRAME, msg: 'req payload must be a JSON object' }
  }
  return { ok: true, frame: { t: 'req', id: parsed.id, m: parsed.m, p: parsed.p ?? {} } }
}

/** Encode one outgoing frame. */
export function encodeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame)
}

/** One successful response frame. */
export function responseFrame(id: number, result: unknown): ResFrame {
  return { t: 'res', id, ok: true, r: result }
}

/** One failed response frame. */
export function errorFrame(id: number, code: string, msg: string): ResFrame {
  return { t: 'res', id, ok: false, e: { code, msg } }
}

/**
 * Per-connection event sequence. The frozen design gives each connection its
 * own counter starting at 1; it is deliberately NOT the DSH session cursor
 * (§3.4), so the two numbers are never compared.
 */
export class EventSequence {
  #next = 1

  /** @returns the next sequence number, advancing the counter. */
  take(): number {
    const value = this.#next
    this.#next += 1
    return value
  }

  /** @returns the value {@link take} will return next, without advancing. */
  peek(): number {
    return this.#next
  }
}
