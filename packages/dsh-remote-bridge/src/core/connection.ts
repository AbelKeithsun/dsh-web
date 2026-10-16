/**
 * One client connection's protocol v1 state machine, transport-agnostic.
 *
 * Everything a connected device can do lives here, and nothing about the
 * WebSocket carrier does: the state machine writes frames through a
 * {@link BridgeTransport}, so the tests drive a whole session — pairing,
 * listing, snapshotting, prompting, approvals — without a socket.
 *
 * Two rules from the frozen design are load-bearing here:
 * - a follow stream is opened once per session with `assistantStream: true`,
 *   and its opening snapshot frame doubles as `session.snapshot`'s answer
 *   (decided after the original §2.1/§2.2 contradiction);
 * - every follow stream is aborted when the connection ends. A stream that
 *   outlives its connection would keep the session's process-local assistant
 *   stream alive for a phone that is gone.
 * @module dsh-remote-bridge/core/connection
 */

import type { ApprovalRegistry } from './approvals.ts'
import type { DeviceRoster } from './devices.ts'
import { deltaOfFollowFrame, pageTurns, readFollowBaseline, ToolCallIndex, trimUnrenderedEntries, turnsOfRecords, type FollowBaseline, type SnapshotTurn } from './dsh-frames.ts'
import { EventSequence, MAX_FRAME_BYTES, decodeClientFrame, encodeFrame, errorFrame, responseFrame, type ReqFrame, type ServerFrame } from './envelope.ts'
import { errorCodeOf, failureText, withServiceUnavailableRetry } from './gateway-errors.ts'
import type { PairingService } from './pairing.ts'
import {
  CAP_SESSION_SNAPSHOT_TRIM,
  CODE_APPROVAL_UNKNOWN,
  CODE_INTERNAL,
  CODE_INVALID_ARGS,
  CODE_NONCE_INVALID,
  CODE_PROTO_UNSUPPORTED,
  CODE_SNAPSHOT_TOO_LARGE,
  CODE_SNAPSHOT_UNAVAILABLE,
  CODE_TOKEN_INVALID,
  CODE_UNKNOWN_METHOD,
  CODE_UNPAIRED,
  KNOWN_METHODS,
  METHOD_APPROVAL_RESOLVE,
  METHOD_HELLO,
  METHOD_PAIR_BEGIN,
  METHOD_PAIR_FINISH,
  METHOD_SESSION_HISTORY,
  METHOD_SESSION_INTERRUPT,
  METHOD_SESSION_LIST,
  METHOD_SESSION_PROMPT,
  METHOD_SESSION_SNAPSHOT,
  METHOD_SESSION_TITLES,
  MINOR,
  PROTO,
  SERVER_ID,
  TOPIC_SESSION_DELTA,
  UNPAIRED_METHODS,
} from './protocol.ts'
import { base64UrlDecode, verifyEs256 } from './crypto.ts'
import { TITLES_MAX_IDS, type SessionMeta } from './session-meta.ts'
import type { BridgeGateway } from './wire.ts'
import { CODE_SUBAGENT_ADDRESS_REQUIRED, sessionAddress, subagentAddress, wireArgs, type SessionAddress } from './wire.ts'

/** Protocol-level heartbeat period: a frame is sent after this long without one. */
export const IDLE_PING_MS = 20_000
/** How long `session.snapshot` waits for its follow stream's opening frame. */
export const SNAPSHOT_OPEN_TIMEOUT_MS = 10_000
/** Largest turn window one snapshot asks DSH for. */
export const SNAPSHOT_MAX_MESSAGES = 200
/** Default byte budget of one `session.history` page: 512 KiB. */
export const HISTORY_PAGE_BYTES = 512 * 1024
/** Highest number of prompt receipts one connection remembers for idempotency. */
export const PROMPT_RECEIPT_LIMIT = 512

/** The carrier a connection writes through. */
export interface BridgeTransport {
  send(text: string): void
  close(code: number, reason: string): void
}

export interface BridgeConnectionOptions {
  readonly gateway: BridgeGateway
  readonly pairing: PairingService
  readonly roster: DeviceRoster
  readonly approvals: ApprovalRegistry
  /** Process-local session metadata: live titles and the host's archive set. */
  readonly sessionMeta: SessionMeta
  readonly now: () => number
  /** This machine's IANA time zone, sent with every prompt. */
  readonly clientTimeZone: () => string | undefined
  readonly log: (message: string) => void
  readonly heartbeatMs?: number
}

/** A device the connection proved itself to be, resolved from the upgrade request. */
export interface ConnectionAuth {
  readonly deviceId: string
}

/** The answer of a subscription's opening frame: a baseline, or why there is none. */
type Opening = { readonly ok: true; readonly baseline: FollowBaseline } | { readonly ok: false; readonly code: string; readonly msg: string }

/** One open follow stream and the answer its opening frame resolves. */
interface Subscription {
  readonly sessionId: string
  readonly controller: AbortController
  /**
   * Mutable on purpose: a delegated child is addressable only through its durable
   * parent, and the bridge learns which address kind applies from the harness's own
   * refusal on the first attempt.
   */
  address: SessionAddress
  opened: Promise<Opening>
}

/** The refusal half of every dispatch outcome. */
interface CallFailure {
  readonly ok: false
  readonly code: string
  readonly msg: string
}

type DispatchOutcome = { readonly ok: true; readonly r: unknown } | CallFailure

/** One session-list row as the protocol publishes it. */
interface SessionRow {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly agentRunning: boolean
  /** The session's working directory, omitted when the host did not report one. */
  readonly cwd?: string
  /** The session this one was delegated from, omitted for a root session. */
  readonly parentSessionId?: string
  /** `subagent` for a delegated session, omitted for an ordinary one. */
  readonly origin?: 'subagent'
  readonly blank: boolean
  /** The host's archive flag; omitted when this process cannot read the archive set. */
  readonly archived?: boolean
}

function refusal(code: string, msg: string): CallFailure {
  return { ok: false, code, msg }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns a non-empty string argument, or undefined. */
function stringArg(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** @returns a non-empty string payload value, or undefined. */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** @returns a non-negative safe integer page argument, or undefined. */
function pageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Read the capability names a `hello` announced.
 *
 * A capability is an announcement, not a negotiation: an unreadable `cap`, an
 * unknown name and an absent key all leave the connection with no capabilities
 * rather than failing the handshake.
 * @param value - the `cap` member of a hello payload, as it crossed the wire.
 * @returns the declared names, empty when the client declared none.
 */
function capabilitiesOf(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.filter((name): name is string => typeof name === 'string' && name !== ''))
}

/**
 * Everything one connected device may do.
 *
 * Not thread-safe by construction but safe by awaiting: handlers are invoked
 * one frame at a time by the carrier's reader, and the only background work is
 * a subscription's own drain loop.
 */
export class BridgeConnection {
  readonly #options: BridgeConnectionOptions
  readonly #transport: BridgeTransport
  readonly #sequence = new EventSequence()
  readonly #subscriptions = new Map<string, Subscription>()
  readonly #receipts = new Set<string>()
  readonly #toolCalls = new ToolCallIndex()
  #capabilities: ReadonlySet<string> = new Set()
  /** Delegated children this connection has learned the durable parent of, by child id. */
  readonly #lineage = new Map<string, string>()
  #lineageRead = false
  #deviceId: string | undefined
  #nonce: { readonly value: string; readonly expiresAt: number } | undefined
  #heartbeat: NodeJS.Timeout | undefined
  #lastSendAt = 0
  #disposed = false

  constructor(options: BridgeConnectionOptions, transport: BridgeTransport, auth?: ConnectionAuth) {
    this.#options = options
    this.#transport = transport
    this.#deviceId = auth?.deviceId
    this.#lastSendAt = options.now()
  }

  /** @returns whether this connection has proven a device token (or just enrolled). */
  get paired(): boolean {
    return this.#deviceId !== undefined
  }

  /** @returns the paired device id, or undefined while unpaired. */
  get deviceId(): string | undefined {
    return this.#deviceId
  }

  /** @returns whether the connection has been torn down. */
  get disposed(): boolean {
    return this.#disposed
  }

  /** Start the idle heartbeat that keeps a quiet phone's socket alive. */
  startHeartbeat(): void {
    if (this.#heartbeat !== undefined) return
    const period = this.#options.heartbeatMs ?? IDLE_PING_MS
    this.#heartbeat = setInterval(() => {
      if (this.#options.now() - this.#lastSendAt >= period) this.#send({ t: 'ping', ts: this.#options.now() })
    }, period)
    this.#heartbeat.unref?.()
  }

  /**
   * Handle one received text frame.
   *
   * This method NEVER rejects. Its caller in the mounted wiring is
   * `void connection.handleText(text)`, so a rejection here would be dropped on
   * the floor and the client would wait forever for an answer that is never
   * coming — the same silent stall as a socket nobody reads. Any unexpected
   * failure (a roster write that cannot complete, a carrier that throws) is
   * answered as an `internal` refusal and logged.
   * @param text - the frame body as it crossed the wire.
   */
  async handleText(text: string): Promise<void> {
    if (this.#disposed) return
    const outcome = decodeClientFrame(text)
    if (!outcome.ok) {
      this.#send(errorFrame(outcome.id, outcome.code, outcome.msg))
      return
    }
    const frame = outcome.frame
    if (frame.t === 'ping') {
      this.#send({ t: 'pong', ts: frame.ts })
      return
    }
    if (frame.t === 'pong') return
    try {
      const answer = await this.#dispatch(frame)
      if (answer.ok) this.#send(responseFrame(frame.id, answer.r))
      else this.#send(errorFrame(frame.id, answer.code, answer.msg))
    } catch (error) {
      this.#options.log(`${frame.m} failed unexpectedly: ${failureText(error)}`)
      this.#send(errorFrame(frame.id, CODE_INTERNAL, failureText(error)))
    }
  }

  /** Push one event to this connection, advancing its own sequence. */
  emit(topic: string, payload: unknown): boolean {
    return this.#emit(topic, payload)
  }

  /**
   * Tear the connection down: stop the heartbeat, abort every follow stream it
   * owns, and tell the carrier to go away. Idempotent, and safe to call from a
   * socket error handler — a carrier whose socket already closed ignores it.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
    for (const subscription of this.#subscriptions.values()) subscription.controller.abort()
    this.#subscriptions.clear()
    // The bridge itself may be unloading with live sockets: the client is told
    // the endpoint is going away instead of being left on a dead protocol.
    this.#transport.close(1001, 'the bridge is going away')
  }

  async #dispatch(frame: ReqFrame): Promise<DispatchOutcome> {
    if (!KNOWN_METHODS.has(frame.m)) return refusal(CODE_UNKNOWN_METHOD, `unknown method ${frame.m}`)
    // Unconditional: a loopback Host buys nothing here. Without a device token
    // only the handshake and the two pairing steps run.
    if (!this.paired && !UNPAIRED_METHODS.has(frame.m)) return refusal(CODE_UNPAIRED, 'this connection is not paired')
    switch (frame.m) {
      case METHOD_HELLO: return this.#hello(frame.p)
      case METHOD_PAIR_BEGIN: return this.#pairBegin(frame.p)
      case METHOD_PAIR_FINISH: return await this.#pairFinish(frame.p)
      case METHOD_SESSION_LIST: return await this.#sessionList()
      case METHOD_SESSION_TITLES: return this.#sessionTitles(frame.p)
      case METHOD_SESSION_SNAPSHOT: return await this.#sessionSnapshot(frame.p, frame.id)
      case METHOD_SESSION_HISTORY: return await this.#sessionHistory(frame.p, frame.id)
      case METHOD_SESSION_PROMPT: return await this.#sessionPrompt(frame.p)
      case METHOD_SESSION_INTERRUPT: return await this.#sessionInterrupt(frame.p)
      case METHOD_APPROVAL_RESOLVE: return this.#approvalResolve(frame.p)
      default: return refusal(CODE_UNKNOWN_METHOD, `unknown method ${frame.m}`)
    }
  }

  #hello(payload: Readonly<Record<string, unknown>>): DispatchOutcome {    const proto = payload.proto
    if (proto !== PROTO) return refusal(CODE_PROTO_UNSUPPORTED, `this bridge speaks protocol ${PROTO}`)
    this.#capabilities = capabilitiesOf(payload.cap)
    return {
      ok: true,
      r: {
        proto: PROTO,
        minor: MINOR,
        server: SERVER_ID,
        resume: 'snapshot',
        auth: this.paired ? 'paired' : 'unpaired',
      },
    }
  }

  #pairBegin(payload: Readonly<Record<string, unknown>>): DispatchOutcome {
    const token = stringArg(payload, 'token')
    if (token === undefined) return refusal(CODE_INVALID_ARGS, 'pair.begin requires token')
    if (!this.#options.pairing.consumeToken(token)) return refusal(CODE_TOKEN_INVALID, 'the bootstrap token is unknown, expired or already used')
    const nonce = this.#options.pairing.issueNonce()
    this.#nonce = { value: nonce.value, expiresAt: nonce.expiresAt }
    return { ok: true, r: { nonce: nonce.value, expiresAt: nonce.expiresAt } }
  }

  async #pairFinish(payload: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const devicePubKey = stringArg(payload, 'devicePubKey')
    const signature = stringArg(payload, 'signature')
    if (devicePubKey === undefined || signature === undefined) {
      return refusal(CODE_INVALID_ARGS, 'pair.finish requires devicePubKey and signature')
    }
    const nonce = this.#nonce
    if (nonce === undefined) return refusal(CODE_NONCE_INVALID, 'this connection has no open pairing')
    // Consume before verifying: a wrong signature burns the challenge instead of
    // leaving it available for another guess.
    this.#nonce = undefined
    if (!this.#options.pairing.consumeNonce(nonce.value) || nonce.expiresAt <= this.#options.now()) {
      return refusal(CODE_NONCE_INVALID, 'the pairing nonce is expired or already used')
    }
    const raw = base64UrlDecode(nonce.value)
    // The design says "the nonce's raw bytes". Both readings of that phrase are
    // accepted — the decoded nonce, and the UTF-8 of the base64url text a client
    // may sign without decoding — because the nonce is one-shot, 60 s, and
    // bound to this connection, so accepting either encoding cannot let an
    // unpaired caller in.
    const signed = raw !== undefined && verifyEs256(devicePubKey, signature, raw)
      ? true
      : verifyEs256(devicePubKey, signature, Buffer.from(nonce.value, 'utf8'))
    if (!signed) return refusal('signature-invalid', 'the ES256 signature does not verify against the device public key')
    const enrollment = await this.#options.roster.enroll(devicePubKey)
    if (enrollment === undefined) return refusal(CODE_INVALID_ARGS, 'devicePubKey is not a P-256 SPKI public key')
    this.#deviceId = enrollment.deviceId
    return { ok: true, r: { deviceToken: enrollment.deviceToken, deviceId: enrollment.deviceId } }
  }

  async #sessionList(): Promise<DispatchOutcome> {
    const call = await this.#unary('session', 'list')
    if (!call.ok) return call
    const items = isRecord(call.value) ? call.value.items : undefined
    if (!Array.isArray(items)) return refusal(CODE_INTERNAL, 'session/list returned no item table')
    // Read once for the whole roster: the archive flag comes from one process-wide
    // set, and an unreadable registry leaves the key out of every row.
    const archived = this.#options.sessionMeta.archiveSet()
    const sessions: SessionRow[] = []
    for (const item of items) {
      if (!isRecord(item) || typeof item.sessionId !== 'string') continue
      const cwd = optionalText(item.cwd)
      const parentSessionId = optionalText(item.parentSessionId)
      sessions.push({
        id: item.sessionId,
        // The roster itself carries no title: `SessionSummary` has none. The
        // connection fills in whatever `session.titles` already resolved for
        // this id and never looks one up here, so listing stays one call.
        title: this.#options.sessionMeta.cachedTitle(item.sessionId) ?? '',
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        agentRunning: item.running === true,
        ...(cwd === undefined ? {} : { cwd }),
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        ...(item.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        blank: item.blank === true,
        ...(archived === undefined ? {} : { archived: archived.has(item.sessionId) }),
      })
    }
    // A listed roster is also the cheapest place to learn lineage: a delegated
    // child's durable parent is on its own row, so a client that lists before it
    // opens a session never costs a second read to address that session.
    this.#rememberLineage(sessions)
    return { ok: true, r: { sessions } }
  }

  /**
   * Answer a batch of title lookups out of this process's title service.
   *
   * Every read is synchronous and in-process, so the batch bound is the whole
   * cost bound: nothing here awaits, opens a follow stream or touches
   * persistence. A session that is not live here, one whose title has not
   * landed yet, and a host without the title service all answer `""` — the
   * batch never fails for one id, and never fails because a service is absent.
   * @param payload - `{ids}`: one to {@link TITLES_MAX_IDS} session ids.
   */
  #sessionTitles(payload: Readonly<Record<string, unknown>>): DispatchOutcome {
    const ids = payload.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > TITLES_MAX_IDS) {
      return refusal(CODE_INVALID_ARGS, `session.titles requires 1 to ${TITLES_MAX_IDS} session ids`)
    }
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') return refusal(CODE_INVALID_ARGS, 'session.titles requires non-empty string ids')
    }
    // The ids are chosen by the client, so the answer map is built on a null
    // prototype: a literal id like `__proto__` has to become a real key.
    const titles = Object.create(null) as Record<string, string>
    for (const id of ids) titles[id] = this.#options.sessionMeta.title(id)
    return { ok: true, r: { titles } }
  }

  async #sessionSnapshot(payload: Readonly<Record<string, unknown>>, id: number): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    if (sessionId === undefined) return refusal(CODE_INVALID_ARGS, 'session.snapshot requires sessionId')
    const opening = await this.#awaitOpening(this.#ensureSubscription(sessionId))
    if (!opening.ok) return refusal(opening.code, `session ${sessionId} produced no opening frame (${opening.msg})`)
    // A client that declared the trim capability chooses what it is sent, never
    // which turns it gets: the projection is trimmed inside each turn first, and
    // only then does the frame budget start dropping whole turns.
    const fitted = this.#fitTurns(this.#projectionOf(opening.baseline.records), opening.baseline.cursor, id)
    if (fitted === undefined) return refusal(CODE_SNAPSHOT_TOO_LARGE, `session ${sessionId} does not fit one ${MAX_FRAME_BYTES} byte frame`)
    return { ok: true, r: { turns: fitted.turns, lastSeq: fitted.lastSeq } }
  }

  /**
   * Read one backwards page of a session's history.
   *
   * Pages are cut from the very baseline `session.snapshot` serves, so the two
   * can never disagree about a turn or an entry; this method only slices that
   * projection, by entry, from the newest entry below the caller's watermark. It
   * is a pure read of the baseline: it never drops, replaces or re-addresses the
   * subscription, and the same cursor always answers the same page.
   * @param payload - `{sessionId, before?, maxBytes?}`.
   * @param id - the request id the page budget is measured against.
   */
  async #sessionHistory(payload: Readonly<Record<string, unknown>>, id: number): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    if (sessionId === undefined) return refusal(CODE_INVALID_ARGS, 'session.history requires sessionId')
    const before = payload.before === undefined ? undefined : pageNumber(payload.before)
    if (payload.before !== undefined && before === undefined) {
      return refusal(CODE_INVALID_ARGS, 'session.history before must be a non-negative integer')
    }
    const maxBytes = payload.maxBytes === undefined ? HISTORY_PAGE_BYTES : pageNumber(payload.maxBytes)
    if (maxBytes === undefined || maxBytes < 1 || maxBytes > MAX_FRAME_BYTES) {
      return refusal(CODE_INVALID_ARGS, `session.history maxBytes must be between 1 and ${MAX_FRAME_BYTES}`)
    }
    const opening = await this.#awaitOpening(this.#ensureSubscription(sessionId))
    if (!opening.ok) return refusal(opening.code, `session ${sessionId} produced no opening frame (${opening.msg})`)
    const page = pageTurns(this.#projectionOf(opening.baseline.records), before, maxBytes, (turns, nextBefore, hasMore) =>
      Buffer.byteLength(JSON.stringify(responseFrame(id, { turns, ...(nextBefore === undefined ? {} : { nextBefore }), hasMore })), 'utf8'))
    return {
      ok: true,
      r: {
        turns: page.turns,
        ...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
        hasMore: page.hasMore,
      },
    }
  }

  /** The projection a baseline is served with: trimmed only for a client that asked for it. */
  #projectionOf(records: readonly unknown[]): SnapshotTurn[] {
    const projected = turnsOfRecords(records)
    return this.#capabilities.has(CAP_SESSION_SNAPSHOT_TRIM) ? trimUnrenderedEntries(projected) : projected
  }

  async #sessionPrompt(payload: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    const text = stringArg(payload, 'text')
    const requestId = stringArg(payload, 'requestId')
    if (sessionId === undefined || text === undefined || requestId === undefined) {
      return refusal(CODE_INVALID_ARGS, 'session.prompt requires sessionId, text and requestId')
    }
    const receipt = `${sessionId}\u0000${requestId}`
    if (this.#receipts.has(receipt)) return { ok: true, r: { accepted: true } }
    // A client may prompt without snapshotting first; the subscription is what
    // makes its own deltas reachable.
    this.#ensureSubscription(sessionId)
    const timeZone = this.#options.clientTimeZone()
    const call = await this.#unary('session', 'prompt', {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      ...(timeZone === undefined || timeZone === '' ? {} : { clientTimeZone: timeZone }),
    })
    if (!call.ok) return call
    this.#rememberReceipt(receipt)
    return { ok: true, r: { accepted: true } }
  }

  async #sessionInterrupt(payload: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    if (sessionId === undefined) return refusal(CODE_INVALID_ARGS, 'session.interrupt requires sessionId')
    // The subscription deliberately outlives this: cancelling a turn is not
    // unsubscribing from the session.
    const call = await this.#unary('session', 'cancel', { sessionId })
    if (!call.ok) return call
    return { ok: true, r: { ok: true } }
  }

  #approvalResolve(payload: Readonly<Record<string, unknown>>): DispatchOutcome {
    const id = stringArg(payload, 'id')
    const decision = payload.decision
    if (id === undefined || (decision !== 'allowed-once' && decision !== 'rejected')) {
      return refusal(CODE_INVALID_ARGS, 'approval.resolve requires id and decision of allowed-once or rejected')
    }
    if (!this.#options.approvals.resolve(id, decision)) {
      return refusal(CODE_APPROVAL_UNKNOWN, 'the question is unknown, already answered or expired')
    }
    return { ok: true, r: { ok: true } }
  }

  /**
   * Run one unary Remote call with the activation retry, converting a gateway
   * failure into a refusal that carries the gateway's own code.
   */
  async #unary(namespace: string, method: string, request: Readonly<Record<string, unknown>> = {}): Promise<{ readonly ok: true; readonly value: unknown } | CallFailure> {
    try {
      const value = await withServiceUnavailableRetry(() => this.#options.gateway.invoke({
        namespace,
        method,
        args: wireArgs(namespace, method, request),
      }))
      return { ok: true, value }
    } catch (error) {
      this.#options.log(`${namespace}/${method} failed: ${failureText(error)}`)
      return refusal(errorCodeOf(error, CODE_INTERNAL), failureText(error))
    }
  }

  #ensureSubscription(sessionId: string): Subscription {
    const existing = this.#subscriptions.get(sessionId)
    if (existing !== undefined) return existing
    const subscription: Subscription = {
      sessionId,
      controller: new AbortController(),
      address: this.#addressOf(sessionId),
      // Resolved without ever rejecting: a caller may subscribe without awaiting
      // the opening frame (`session.prompt` does exactly that), and an unobserved
      // rejection would take the whole host process down under node's default
      // `--unhandled-rejections=throw`.
      opened: Promise.resolve({ ok: false, code: CODE_SNAPSHOT_UNAVAILABLE, msg: 'the stream was not opened' }),
    }
    subscription.opened = this.#openSubscription(subscription)
    this.#subscriptions.set(sessionId, subscription)
    return subscription
  }

  /** The durable address of one session, as far as this connection has learned it. */
  #addressOf(sessionId: string): SessionAddress {
    const parent = this.#lineage.get(sessionId)
    return parent === undefined ? sessionAddress(sessionId) : subagentAddress(parent, sessionId)
  }

  /** Remember the durable parent of every delegated child a roster carried. */
  #rememberLineage(rows: readonly SessionRow[]): void {
    for (const row of rows) {
      if (row.origin === 'subagent' && row.parentSessionId !== undefined) this.#lineage.set(row.id, row.parentSessionId)
    }
  }

  /**
   * The durable parent of a delegated child, or undefined when the roster does
   * not name one.
   *
   * The roster is the only endpoint that carries lineage, so it is read at most
   * once per connection: a client that listed sessions has already populated the
   * map, and a child opened without a listing costs exactly one roster read.
   */
  async #parentOf(sessionId: string): Promise<string | undefined> {
    const known = this.#lineage.get(sessionId)
    if (known !== undefined || this.#lineageRead) return known
    const roster = await this.#sessionList()
    if (roster.ok) this.#lineageRead = true
    return this.#lineage.get(sessionId)
  }

  /**
   * Open one follow stream, resolving the address kind the harness demands.
   *
   * A delegated child is addressable only through its durable parent, and the
   * harness answers `session/agent-busy` when it is asked as an ordinary session.
   * That refusal is the one signal that distinguishes it from a real failure, so
   * it is the only one that triggers a roster lookup and a retry — everything
   * else crosses to the caller unchanged.
   */
  async #openSubscription(subscription: Subscription): Promise<Opening> {
    let outcome = await this.#openFollow(subscription)
    if (!outcome.ok && outcome.code === CODE_SUBAGENT_ADDRESS_REQUIRED) {
      const parent = await this.#parentOf(subscription.sessionId)
      if (parent !== undefined) {
        this.#lineage.set(subscription.sessionId, parent)
        subscription.address = subagentAddress(parent, subscription.sessionId)
        outcome = await this.#openFollow(subscription)
      }
    }
    if (!outcome.ok) {
      // The stream is unusable for this connection: drop it rather than leaving a
      // half-open subscription behind, so a later call starts a fresh one.
      this.#forget(subscription)
      subscription.controller.abort()
    }
    return outcome
  }

  /** One attempt at the opening frame of a follow stream. */
  async #openFollow(subscription: Subscription): Promise<Opening> {
    let iterator: AsyncIterator<unknown>
    try {
      const stream = await withServiceUnavailableRetry(() => this.#options.gateway.stream({
        namespace: 'session',
        method: 'follow',
        args: wireArgs('session', 'follow', {
          address: subscription.address,
          // Decided after the frozen design's §2.1/§2.2 contradiction: one stream
          // per session carries both the baseline and the process-local deltas.
          assistantStream: true,
          maxMessages: SNAPSHOT_MAX_MESSAGES,
        }),
        signal: subscription.controller.signal,
      }))
      iterator = stream[Symbol.asyncIterator]()
    } catch (error) {
      return { ok: false, code: errorCodeOf(error, CODE_SNAPSHOT_UNAVAILABLE), msg: failureText(error) }
    }
    try {
      const first = await iterator.next()
      const baseline = first.done === true ? undefined : readFollowBaseline(first.value)
      if (baseline === undefined) {
        await iterator.return?.()
        return { ok: false, code: CODE_SNAPSHOT_UNAVAILABLE, msg: 'session/follow returned no opening snapshot frame' }
      }
      void this.#drain(subscription, iterator)
      return { ok: true, baseline }
    } catch (error) {
      return { ok: false, code: errorCodeOf(error, CODE_SNAPSHOT_UNAVAILABLE), msg: failureText(error) }
    }
  }

  /** Consume the rest of a follow stream, publishing every increment. */
  async #drain(subscription: Subscription, iterator: AsyncIterator<unknown>): Promise<void> {
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) return
        const delta = deltaOfFollowFrame(next.value, this.#toolCalls)
        if (delta === undefined) continue
        this.#emit(TOPIC_SESSION_DELTA, { sessionId: subscription.sessionId, ...delta })
      }
    } catch (error) {
      if (!subscription.controller.signal.aborted) {
        this.#options.log(`session ${subscription.sessionId} follow stream ended: ${failureText(error)}`)
      }
    } finally {
      this.#forget(subscription)
    }
  }

  /** Await a subscription's opening frame under a bounded wait. */
  async #awaitOpening(subscription: Subscription): Promise<Opening> {
    let timer: NodeJS.Timeout | undefined
    const expiry = new Promise<undefined>(resolve => {
      timer = setTimeout(() => { resolve(undefined) }, SNAPSHOT_OPEN_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race([subscription.opened, expiry])
      if (outcome !== undefined) return outcome
      // No opening frame in time means the stream is unusable for this connection:
      // drop it rather than leaving a half-open subscription behind.
      subscription.controller.abort()
      this.#forget(subscription)
      return { ok: false, code: CODE_SNAPSHOT_UNAVAILABLE, msg: `no opening frame within ${SNAPSHOT_OPEN_TIMEOUT_MS} ms` }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Drop a subscription only while it is still the current one for its session. */
  #forget(subscription: Subscription): void {
    if (this.#subscriptions.get(subscription.sessionId) === subscription) this.#subscriptions.delete(subscription.sessionId)
  }

  /**
   * Shrink a snapshot until it fits one frame, dropping whole oldest turns.
   * @returns the fitting payload, or undefined when even one turn cannot fit.
   */
  #fitTurns(turns: readonly SnapshotTurn[], cursor: number, id: number): { readonly turns: readonly SnapshotTurn[]; readonly lastSeq: number } | undefined {
    let kept = [...turns]
    for (;;) {
      const frame = responseFrame(id, { turns: kept, lastSeq: cursor })
      if (Buffer.byteLength(JSON.stringify(frame), 'utf8') <= MAX_FRAME_BYTES) return { turns: kept, lastSeq: cursor }
      if (kept.length <= 1) return undefined
      kept = kept.slice(1)
    }
  }

  #rememberReceipt(receipt: string): void {
    this.#receipts.add(receipt)
    while (this.#receipts.size > PROMPT_RECEIPT_LIMIT) {
      const oldest = this.#receipts.values().next()
      if (oldest.done === true) break
      this.#receipts.delete(oldest.value)
    }
  }

  #emit(topic: string, payload: unknown): boolean {
    if (this.#disposed) return false
    const frame: ServerFrame = { t: 'ev', seq: this.#sequence.take(), m: topic, p: payload }
    const text = encodeFrame(frame)
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
      this.#options.log(`dropped a ${topic} event past ${MAX_FRAME_BYTES} bytes`)
      return false
    }
    return this.#write(text)
  }

  #send(frame: ServerFrame): void {
    if (this.#disposed) return
    this.#write(encodeFrame(frame))
  }

  /**
   * Hand one encoded frame to the carrier.
   *
   * A carrier that throws must not take the process down with it: every write
   * here happens either inside a socket `data` handler or inside the approval
   * waterfall, where an escaping exception becomes an uncaught exception. A
   * failure is logged and the frame is dropped — the socket is already gone by
   * then, so there is nobody left to answer.
   * @returns whether the frame was handed to the carrier.
   */
  #write(text: string): boolean {
    try {
      this.#transport.send(text)
    } catch (error) {
      this.#options.log(`could not write a frame: ${failureText(error)}`)
      return false
    }
    this.#lastSendAt = this.#options.now()
    return true
  }
}
