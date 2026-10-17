/**
 * Test doubles for the bridge suites: a recording carrier, a scriptable
 * gateway, and a connection factory whose dependencies are all real except the
 * gateway. Nothing here patches a module or spies on a service method — the
 * gateway is injected, which is exactly the seam the production code already
 * takes.
 * @module tests/support/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { BridgeConnection, type BridgeConnectionOptions, type BridgeTransport, type ConnectionAuth } from '../../src/core/connection.ts'
import { ApprovalRegistry } from '../../src/core/approvals.ts'
import { DeviceRoster } from '../../src/core/devices.ts'
import { BridgeHub } from '../../src/core/hub.ts'
import { createOwnerPeer } from '../../src/core/owner-peer.ts'
import { PairingService } from '../../src/core/pairing.ts'
import { QuestionClaims } from '../../src/core/questions.ts'
import { SessionMeta, type SessionMetaFaces } from '../../src/core/session-meta.ts'
import { SessionPermissions } from '../../src/core/session-permissions.ts'
import type { BridgeGateway, GatewayInvokeRequest, GatewayPeer } from '../../src/core/wire.ts'

/** One frame as it crossed the wire. */
export interface WireFrame {
  readonly t: string
  readonly [key: string]: unknown
}

/** One request the connection made through the gateway. */
export interface RecordedCall {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  /** The caller the call spoke for; the suites assert the bridge's own owner peer crosses, never a client-supplied one. */
  readonly peer: GatewayPeer
  readonly signal: AbortSignal | undefined
}

/** A carrier that keeps every frame instead of writing a socket. */
export class RecordingTransport implements BridgeTransport {
  readonly sent: string[] = []
  closed: { code: number; reason: string } | undefined

  send(text: string): void {
    this.sent.push(text)
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }

  /** @returns every frame, parsed. */
  frames(): WireFrame[] {
    return this.sent.map(text => JSON.parse(text) as WireFrame)
  }

  /** @returns the frames with the given `t`. */
  ofType(kind: string): WireFrame[] {
    return this.frames().filter(frame => frame.t === kind)
  }

  /** @returns the response frame for one request id, or undefined when none arrived. */
  responseTo(id: number): WireFrame | undefined {
    return this.frames().find(frame => frame.t === 'res' && frame.id === id)
  }

  /** @returns the last frame received, or undefined. */
  last(): WireFrame | undefined {
    const frames = this.frames()
    return frames[frames.length - 1]
  }
}

/** A gateway whose every answer is scripted by the test. */
export class FakeGateway implements BridgeGateway {
  readonly invocations: RecordedCall[] = []
  readonly streamRequests: RecordedCall[] = []
  /** Unary answers; the default accepts everything. */
  handler: (call: RecordedCall) => Promise<unknown> = async () => ({ accepted: true })
  /** Follow streams by session id. */
  follow: (call: RecordedCall) => AsyncIterable<unknown> = () => new ControllableStream().iterable()

  invoke(request: GatewayInvokeRequest): Promise<unknown> {
    const call: RecordedCall = { namespace: request.namespace, method: request.method, args: request.args, peer: request.peer, signal: request.signal }
    this.invocations.push(call)
    return this.handler(call)
  }

  stream(request: GatewayInvokeRequest): Promise<AsyncIterable<unknown>> {
    const call: RecordedCall = { namespace: request.namespace, method: request.method, args: request.args, peer: request.peer, signal: request.signal }
    this.streamRequests.push(call)
    return Promise.resolve(this.follow(call))
  }

  /** @returns the args of the last invocation of one endpoint. */
  lastArgs(namespace: string, method: string): Readonly<Record<string, unknown>> | undefined {
    for (let index = this.invocations.length - 1; index >= 0; index -= 1) {
      const call = this.invocations[index]
      if (call?.namespace === namespace && call.method === method) return call.args
    }
    return undefined
  }

  /** @returns how many times one endpoint was invoked. */
  countOf(namespace: string, method: string): number {
    return this.invocations.filter(call => call.namespace === namespace && call.method === method).length
  }
}

/**
 * A follow stream a test drives one frame at a time.
 *
 * Aborting the signal ends the stream, which is how the suites prove that a
 * closed connection does not leave a session subscription running.
 */
export class ControllableStream {
  readonly #queue: unknown[] = []
  readonly #waiters: ((result: IteratorResult<unknown>) => void)[] = []
  #ended = false
  #signal: AbortSignal | undefined

  /** Take the follow call's signal so an abort ends the stream. */
  attach(signal: AbortSignal | undefined): this {
    this.#signal = signal
    signal?.addEventListener('abort', () => { this.end() }, { once: true })
    return this
  }

  /** @returns whether the stream has been ended (by the test or by an abort). */
  get ended(): boolean {
    return this.#ended
  }

  /** Whether the producing signal was aborted. */
  get aborted(): boolean {
    return this.#signal?.aborted === true
  }

  push(frame: unknown): this {
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: frame })
    else this.#queue.push(frame)
    return this
  }

  end(): this {
    if (this.#ended) return this
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
    return this
  }

  /** @returns the iterable a gateway hands back. */
  iterable(): AsyncIterable<unknown> {
    return { [Symbol.asyncIterator]: () => this }
  }

  next(): Promise<IteratorResult<unknown>> {
    const queued = this.#queue.shift()
    if (queued !== undefined) return Promise.resolve({ done: false, value: queued })
    if (this.#ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => { this.#waiters.push(resolve) })
  }

  return(): Promise<IteratorResult<unknown>> {
    this.end()
    return Promise.resolve({ done: true, value: undefined })
  }
}

/** Everything one connection was built with, so a test can inspect each part. */
export interface ConnectionHarness {
  readonly connection: BridgeConnection
  readonly transport: RecordingTransport
  readonly gateway: FakeGateway
  readonly pairing: PairingService
  readonly roster: DeviceRoster
  readonly approvals: ApprovalRegistry
  readonly ownerPeer: GatewayPeer
  readonly questions: QuestionClaims
  readonly logs: string[]
}

export interface HarnessOptions {
  /** Marks the connection as already paired with a device token. */
  readonly paired?: boolean
  /** Roster file path; a nonexistent path under a temp directory is enough. */
  readonly rosterFile?: string
  /** Roster stand-in, for the failure paths a real file cannot be made to take. */
  readonly roster?: DeviceRoster
  /** Session metadata source; the default models a host with no such service mounted. */
  readonly sessionMeta?: SessionMeta
  /** Permission presets source; the default models a host with no such service mounted. */
  readonly permissions?: SessionPermissions
  readonly heartbeatMs?: number
  /** Id source for the call ids the question channel mints; the default is random. */
  readonly questionIds?: (byteLength: number) => string
}

/** Session metadata for a host whose session services are all present. */
function metaOf(options: HarnessOptions, log: (message: string) => void): SessionMeta {
  return options.sessionMeta ?? new SessionMeta(() => ({}), () => Date.now(), log)
}

/**
 * A title service over one fixed table, plus the live-session store in front of
 * it — the two faces {@link SessionMeta} reads.
 */
export interface TitlesDouble {
  /** The faces one `SessionMeta` is built from. */
  readonly faces: SessionMetaFaces
  /** The ids the title service was actually asked for, in order. */
  readonly reads: string[]
}

/**
 * Build a title double.
 * @param table - titles by session id.
 * @param live - ids the store reports as live sessions; defaults to the table's keys.
 * @returns the faces, and the log of every id the title service was asked for.
 */
export function titlesDouble(table: Record<string, string>, live: readonly string[] = Object.keys(table)): TitlesDouble {
  const reads: string[] = []
  return {
    reads,
    faces: {
      sessions: { get: id => (live.includes(id) ? { id } : undefined) },
      titles: {
        get: session => {
          reads.push(session.id)
          const title = table[session.id]
          return title === undefined ? undefined : { title }
        },
      },
    },
  }
}

/** Build one connection over the recording carrier. */
export function makeConnection(options: HarnessOptions = {}): ConnectionHarness {
  const transport = new RecordingTransport()
  const gateway = new FakeGateway()
  const pairing = new PairingService()
  const roster = options.roster ?? new DeviceRoster({ file: options.rosterFile ?? '/tmp/dsh-remote-bridge-test/not-loaded.json' })
  const approvals = new ApprovalRegistry()
  const logs: string[] = []
  const ownerPeer = createOwnerPeer(new Context())
  const questions = new QuestionClaims({
    gateway,
    log: message => { logs.push(message) },
    ...(options.questionIds === undefined ? {} : { random: options.questionIds }),
  })
  const settings: BridgeConnectionOptions = {
    gateway,
    pairing,
    roster,
    approvals,
    questions,
    sessionMeta: metaOf(options, message => { logs.push(message) }),
    permissions: options.permissions ?? new SessionPermissions(() => ({}), message => { logs.push(message) }),
    ownerPeer,
    now: () => Date.now(),
    clientTimeZone: () => 'Asia/Shanghai',
    log: (message: string) => { logs.push(message) },
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  }
  const auth: ConnectionAuth | undefined = options.paired === true ? { deviceId: 'dev_harness' } : undefined
  const connection = new BridgeConnection(settings, transport, auth)
  return { connection, transport, gateway, pairing, roster, approvals, ownerPeer, questions, logs }
}

/** One request frame, serialized the way a client sends it. */
export function requestFrame(id: number, method: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ t: 'req', id, m: method, p: payload })
}

/**
 * Let the connection's background work run to its next await.
 * @param rounds - microtask hops; enough for the drain loop to publish one pushed frame.
 */
export async function settle(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

/**
 * Yield exactly one event-loop turn, for the events Node emits after the turn
 * that caused them (a destroyed stream reports `close` this way). This is an
 * ordering primitive, not a wait: the turn is deterministic and has no duration.
 */
export async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

/** Everything a hub was built with, plus the one connection attached to it. */
export interface HubHarness {
  readonly hub: BridgeHub
  readonly connection: BridgeConnection
  readonly transport: RecordingTransport
  readonly gateway: FakeGateway
  readonly approvals: ApprovalRegistry
  readonly ownerPeer: GatewayPeer
  readonly questions: QuestionClaims
  readonly logs: string[]
}

/** Build one hub with one attached connection. */
export function makeHub(options: HarnessOptions = {}): HubHarness {
  const bare = makeBareHub(options)
  const transport = new RecordingTransport()
  const connection = bare.hub.attach(transport, options.paired === false ? undefined : { deviceId: 'dev_harness' })
  return { ...bare, connection, transport }
}

/** Everything a hub was built with, before any connection is attached to it. */
export interface BareHubHarness {
  readonly hub: BridgeHub
  readonly gateway: FakeGateway
  readonly approvals: ApprovalRegistry
  readonly ownerPeer: GatewayPeer
  readonly questions: QuestionClaims
  readonly logs: string[]
}

/** Build one hub with nothing attached, for suites that bring their own carrier. */
export function makeBareHub(options: HarnessOptions = {}): BareHubHarness {
  const gateway = new FakeGateway()
  const approvals = new ApprovalRegistry()
  const logs: string[] = []
  const ownerPeer = createOwnerPeer(new Context())
  const questions = new QuestionClaims({
    gateway,
    log: message => { logs.push(message) },
    ...(options.questionIds === undefined ? {} : { random: options.questionIds }),
  })
  const hub = new BridgeHub({
    gateway,
    pairing: new PairingService(),
    roster: options.roster ?? new DeviceRoster({ file: options.rosterFile ?? '/tmp/dsh-remote-bridge-test/not-loaded.json' }),
    approvals,
    questions,
    sessionMeta: metaOf(options, message => { logs.push(message) }),
    permissions: options.permissions ?? new SessionPermissions(() => ({}), message => { logs.push(message) }),
    ownerPeer,
    now: () => Date.now(),
    clientTimeZone: () => undefined,
    log: (message: string) => { logs.push(message) },
  })
  return { hub, gateway, approvals, ownerPeer, questions, logs }
}

/** One response frame's `ok`, `r` and `e`, exactly as the client reads them. */
export function answerOf(harness: { readonly transport: RecordingTransport }, id: number): { ok: boolean; r?: unknown; e?: { code: string; msg: string } } {
  const frame = harness.transport.responseTo(id)
  if (frame === undefined) throw new Error(`no response for request ${id}`)
  const { ok, r, e } = frame as unknown as { ok: boolean; r?: unknown; e?: { code: string; msg: string } }
  return e === undefined ? { ok, r } : { ok, e }
}
