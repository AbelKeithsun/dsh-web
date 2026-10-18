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
import { ROSTER_DELTA_MAX_ROWS, RemoteBridgeDeltas, type DeltaRow } from './delta.ts'
import { deltaOfFollowFrame, MessageIndex, pageTurns, readFollowBaseline, SpawnCallIndex, ToolCallIndex, trimUnrenderedEntries, turnsOfRecords, type FollowBaseline, type SnapshotTurn } from './dsh-frames.ts'
import { EventSequence, FRAME_TOO_LARGE, MAX_FRAME_BYTES, decodeClientFrame, encodeFrame, errorFrame, responseFrame, type ReqFrame, type ServerFrame } from './envelope.ts'
import type { RemoteBridgeMethodResult, RemoteBridgeRegistry } from './extension.ts'
import { errorCodeOf, failureText, withServiceUnavailableRetry } from './gateway-errors.ts'
import { scopeKey, type JobRoster, type JobsPayload } from './jobs.ts'
import type { PairingService } from './pairing.ts'
import type { QuestionAnswerItem, QuestionClaims } from './questions.ts'
import {
  CAP_AGENTS,
  CAP_DELTA,
  CAP_FRAME_DEFLATE,
  CAP_JOBS,
  CAP_QUESTIONS,
  CAP_SESSION_SNAPSHOT_PAGE,
  CAP_SESSION_SNAPSHOT_TRIM,
  CAP_SUBAGENT_THREAD,
  CODE_APPROVAL_UNKNOWN,
  CODE_INTERNAL,
  CODE_INVALID_ARGS,
  CODE_JOBS_UNAVAILABLE,
  CODE_NONCE_INVALID,
  CODE_PROTO_UNSUPPORTED,
  CODE_SESSION_NOT_FOLLOWABLE,
  CODE_SNAPSHOT_TOO_LARGE,
  CODE_SNAPSHOT_UNAVAILABLE,
  CODE_TOKEN_INVALID,
  CODE_UNKNOWN_METHOD,
  CODE_UNPAIRED,
  KNOWN_METHODS,
  METHOD_APPROVAL_RESOLVE,
  METHOD_HELLO,
  METHOD_JOBS_LIST,
  METHOD_PAIR_BEGIN,
  METHOD_PAIR_FINISH,
  METHOD_PRESETS_LIST,
  METHOD_QUESTION_ANSWER,
  METHOD_SESSION_ATTACHMENT,
  METHOD_SESSION_CREATE,
  METHOD_SESSION_HISTORY,
  METHOD_SESSION_HISTORY_DEEP,
  METHOD_SESSION_INTERRUPT,
  METHOD_SESSION_LIST,
  METHOD_SESSION_MODELS,
  METHOD_SESSION_PERMISSIONS,
  METHOD_SESSION_PROMPT,
  METHOD_SESSION_SET_MODEL,
  METHOD_SESSION_SET_PERMISSION,
  METHOD_SESSION_SNAPSHOT,
  METHOD_SESSION_TITLES,
  MINOR,
  PROTO,
  SERVED_CAPABILITIES,
  SERVER_ID,
  TOPIC_JOBS_CHANGED,
  TOPIC_SESSION_DELTA,
  UNPAIRED_METHODS,
} from './protocol.ts'
import { base64UrlDecode, verifyEs256 } from './crypto.ts'
import { TITLES_MAX_IDS, type SessionMeta } from './session-meta.ts'
import type { SessionPermissions } from './session-permissions.ts'
import type { BridgeGateway, GatewayPeer } from './wire.ts'
import { CODE_SUBAGENT_ADDRESS_REQUIRED, sessionAddress, subagentAddress, wireArgs, type SessionAddress } from './wire.ts'

/** Protocol-level heartbeat period: a frame is sent after this long without one. */
export const IDLE_PING_MS = 20_000
/** How long `session.snapshot` waits for its follow stream's opening frame. */
export const SNAPSHOT_OPEN_TIMEOUT_MS = 10_000
/** Largest turn window one snapshot asks DSH for. */
export const SNAPSHOT_MAX_MESSAGES = 200
/** Default byte budget of one `session.history` page: 512 KiB. */
export const HISTORY_PAGE_BYTES = 512 * 1024
/**
 * Window one `session.history.deep` read asks DSH for: at least 50 user or
 * assistant messages across at least 2 turns, and never more than 500 messages.
 *
 * It is the window the harness's own Web client pages history with, and it is
 * deliberately wider than one answer: a byte budget is the caller's, so the
 * store is asked for a whole span once and the bridge then cuts that span to
 * `maxBytes` by entry. Nothing in the answer depends on where the store cut:
 * the host's `hasMore` is folded into the answer's own `hasMore`, and the
 * cursor is always the oldest entry the answer carries.
 */
export const DEEP_HISTORY_WINDOW = {
  maxMessages: 500,
  turnWindow: { minMessages: 50, minTurns: 2 },
} as const
/** Highest number of prompt receipts one connection remembers for idempotency. */
export const PROMPT_RECEIPT_LIMIT = 512
/** Largest base64 text one prompt attachment may carry: 6 MiB (protocol §10.2). */
export const PROMPT_ATTACHMENT_MAX_BYTES = 6 * 1024 * 1024

/** The carrier a connection writes through. */
export interface BridgeTransport {
  send(text: string): void
  close(code: number, reason: string): void
  /**
   * Optional: whether the peer declared `frame.deflate.v1`, reported once the
   * `hello` that declares it has been recorded. The capability is the client's
   * declaration and the wire form is the carrier's, so this is the one fact that
   * has to cross between them. A carrier with no socket to compress — a
   * recording double, for one — omits the member and keeps writing text.
   */
  frameDeflate?(declared: boolean): void
}

export interface BridgeConnectionOptions {
  readonly gateway: BridgeGateway
  readonly pairing: PairingService
  readonly roster: DeviceRoster
  readonly approvals: ApprovalRegistry
  /** Pending user questions: the claims this bridge holds and the answer path back to the host. */
  readonly questions: QuestionClaims
  /** The host's background jobs: the read-only projection and the scopes this connection watches. */
  readonly jobs: JobRoster
  /** Process-local session metadata: live titles and the host's archive set. */
  readonly sessionMeta: SessionMeta
  /** Host-process permission presets, read and switched through their real service objects. */
  readonly permissions: SessionPermissions
  /**
   * The in-process owner peer every gateway call speaks for, minted by the
   * bridge itself (`core/owner-peer.ts`). Dispatch refuses unpaired
   * connections before any gateway call exists, so this peer — a
   * full-control credential — is exercised only behind the bridge's own
   * pairing gate, and no client frame field is ever read into it.
   */
  readonly ownerPeer: GatewayPeer
  readonly now: () => number
  /** This machine's IANA time zone, sent with every prompt. */
  readonly clientTimeZone: () => string | undefined
  readonly log: (message: string) => void
  /**
   * Called after a client's `hello` records its capabilities, so the hub can hand
   * it whatever it can now receive but was not there to see.
   */
  readonly onDeclare?: (connection: BridgeConnection) => void
  readonly heartbeatMs?: number
  /**
   * Methods plugins registered on the bridge's extension seam. Absent is the
   * protocol exactly as this package defines it: every name outside
   * `KNOWN_METHODS` answers `unknown-method`.
   */
  readonly extensions?: RemoteBridgeRegistry
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
interface SessionRow extends DeltaRow {
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

/**
 * The opaque `since` token one request carried.
 *
 * Anything that is not a non-empty string is "no usable token", which answers a
 * reset — the same answer an unknown token gets, because a request that named
 * no base cannot be diffed against one.
 * @param payload - the request's `p`.
 * @returns the token, or undefined.
 */
function sinceOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload.since
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Whether a plugin's answer is one of the two shapes the seam defines.
 *
 * An extension is ordinary JavaScript calling into this bridge, so a result the
 * type system never saw still has to leave the client with an answer instead of
 * a lost frame.
 * @param value - what the extension method returned.
 * @returns whether it carries a usable answer or refusal.
 */
function isMethodResult(value: unknown): value is RemoteBridgeMethodResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as { ok?: unknown; code?: unknown; msg?: unknown }
  if (result.ok === true) return true
  if (result.ok !== false) return false
  return typeof result.code === 'string' && result.code !== '' && typeof result.msg === 'string'
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
 * Read one request's page budget.
 *
 * An absent budget is {@link HISTORY_PAGE_BYTES}; a budget an encoded page
 * could never be measured against — zero, fractional, negative or larger than
 * one frame — is refused rather than clamped, so a caller never mistakes a
 * silently reduced page for the one it asked for.
 * @param value - the request's `maxBytes` member, or undefined.
 * @param method - the method name the refusal names.
 */
function pageBudgetOf(value: unknown, method: string): { readonly ok: true; readonly maxBytes: number } | CallFailure {
  if (value === undefined) return { ok: true, maxBytes: HISTORY_PAGE_BYTES }
  const maxBytes = pageNumber(value)
  if (maxBytes === undefined || maxBytes < 1 || maxBytes > MAX_FRAME_BYTES) {
    return refusal(CODE_INVALID_ARGS, `${method} maxBytes must be between 1 and ${MAX_FRAME_BYTES}`)
  }
  return { ok: true, maxBytes }
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
 * Validate `question.answer`'s answer batch.
 *
 * The host validates the batch against the questions it actually asked (missing,
 * duplicated or invented ids are the host's own `BAD_ANSWER`), so this only
 * refuses what is not an answer at all: a non-array, an entry that is not an
 * object, an entry without a non-empty id, or `selected` that is not a list of
 * non-empty labels.
 * @param value - the request's `answers` member, or undefined.
 * @returns the batch in protocol vocabulary, or undefined when it is not one.
 */
function answersOf(value: unknown): readonly QuestionAnswerItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const answers: QuestionAnswerItem[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    const id = optionalText(entry.id)
    const selected = entry.selected
    if (id === undefined || !Array.isArray(selected)) return undefined
    if (!selected.every(label => typeof label === 'string' && label !== '')) return undefined
    const custom = optionalText(entry.custom)
    answers.push({ id, selected: selected as string[], ...(custom === undefined ? {} : { custom }) })
  }
  return answers
}

/** One model selection, in the field names the protocol publishes. */
type ModelSelection = {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** @returns the selection this value describes, or undefined when it describes none. */
function selectionOf(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined
  const provider = optionalText(value.provider)
  const model = optionalText(value.model)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = optionalText(value.reasoningEffort)
  return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort }
}

/**
 * The durable model-selection fold of one `session/projections` answer.
 *
 * Both halves stay optional: a session that never ran has neither, and the
 * catalog default is then the only truthful current value.
 */
function modelSelectionOf(value: unknown): { readonly next?: ModelSelection; readonly lastUsed?: ModelSelection } {
  if (!isRecord(value) || !isRecord(value.values)) return {}
  const selection = value.values.modelSelection
  if (!isRecord(selection)) return {}
  const next = selectionOf(selection.next)
  const lastUsed = selectionOf(selection.lastUsed)
  return {
    ...(next === undefined ? {} : { next }),
    ...(lastUsed === undefined ? {} : { lastUsed }),
  }
}

/** One prompt attachment, already projected to the harness's image content part. */
type PromptAttachment = Readonly<Record<string, unknown>>

/** The validated attachments of one prompt, or the refusal that withheld it. */
type PromptAttachments = { readonly ok: true; readonly parts: readonly PromptAttachment[] } | CallFailure

/**
 * Validate `session.prompt`'s optional attachments and project them to the
 * harness's image content parts, keeping the order the client sent.
 *
 * The per-attachment budget is checked here rather than at the harness: 6 MiB of
 * base64 per attachment is what keeps a prompt frame inside the envelope's
 * 10 MiB, and the refusal names the attachment and its exact byte count so the
 * phone can say which pick made the send fail. Nothing is truncated and nothing
 * is dropped — one rejected attachment withholds the whole prompt.
 * @param value - the request's `attachments` member, or undefined.
 */
function promptAttachmentsOf(value: unknown): PromptAttachments {
  if (value === undefined) return { ok: true, parts: [] }
  if (!Array.isArray(value)) return refusal(CODE_INVALID_ARGS, 'session.prompt attachments must be an array')
  const parts: PromptAttachment[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return refusal(CODE_INVALID_ARGS, 'session.prompt attachments must be objects')
    const name = optionalText(entry.name)
    const label = name === undefined ? `attachment ${parts.length + 1}` : `attachment "${name}"`
    const mediaType = optionalText(entry.mediaType)
    const data = typeof entry.data === 'string' ? entry.data : undefined
    if (mediaType === undefined || data === undefined || data === '') {
      return refusal(CODE_INVALID_ARGS, `session.prompt ${label} requires mediaType and base64 data`)
    }
    const bytes = Buffer.byteLength(data, 'utf8')
    if (bytes > PROMPT_ATTACHMENT_MAX_BYTES) {
      return refusal(
        CODE_INVALID_ARGS,
        `session.prompt ${label} is ${bytes} base64 bytes, past the ${PROMPT_ATTACHMENT_MAX_BYTES} byte limit`,
      )
    }
    parts.push({ type: 'image', mediaType, data, ...(name === undefined ? {} : { name }) })
  }
  return { ok: true, parts }
}

/**
 * Everything one connected device may do.
 *
 * Not thread-safe by construction but safe by awaiting: handlers are invoked
 * one frame at a time by the carrier's reader, and the only background work is
 * a subscription's own drain loop.
 */
/**
 * Monotonic source for {@link BridgeConnection.id}. The counter is process-wide
 * and never reused, so a plugin keying connection-scoped state can trust that a
 * reclaimed id belongs to no later socket.
 */
let connectionSeq = 0

export class BridgeConnection {
  readonly #id = `c${connectionSeq += 1}`
  readonly #options: BridgeConnectionOptions
  readonly #transport: BridgeTransport
  readonly #sequence = new EventSequence()
  readonly #subscriptions = new Map<string, Subscription>()
  readonly #receipts = new Set<string>()
  readonly #toolCalls = new ToolCallIndex()
  readonly #messages = new MessageIndex()
  #capabilities: ReadonlySet<string> = new Set()
  /** Delegated children this connection has learned the durable parent of, by child id. */
  readonly #lineage = new Map<string, string>()
  /**
   * Sessions this connection may read: the ordinary sessions the host's roster
   * names, plus every session this connection already opened. A delegated child
   * belongs here only once it has been opened itself, never because the roster
   * merely names it.
   */
  readonly #authorized = new Set<string>()
  /**
   * The job scopes this connection asked about, by {@link scopeKey}, with the
   * disposer of each watch. A scope is watched exactly while this connection has
   * listed it: that is what keeps a declared capability from turning into a
   * subscription the client never requested.
   */
  readonly #jobWatches = new Map<string, () => void>()
  /** The last roster payload this connection received per scope key, for whole-set dedupe. */
  readonly #jobSeen = new Map<string, string>()
  /**
   * This connection's delta windows, one per set it is served incrementally.
   * Held here so the base is released exactly when the connection is, and so no
   * two connections can ever diff against each other's set.
   */
  readonly #deltas = new RemoteBridgeDeltas()
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

  /**
   * @returns this connection's identity for the extension seam. Stable for the
   * life of the socket and never reused by a later one.
   */
  get id(): string {
    return this.#id
  }

  /**
   * @param capability - one capability name this protocol defines.
   * @returns whether this connection announced it in `hello`.
   */
  declares(capability: string): boolean {
    return this.#capabilities.has(capability)
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
    // A scope nobody left can read must stop costing the host a read per burst.
    for (const dispose of this.#jobWatches.values()) dispose()
    this.#jobWatches.clear()
    this.#jobSeen.clear()
    // A dropped connection's incremental bases are released with it: a token it
    // was given names nothing afterwards, and nothing here outlives its socket.
    this.#deltas.clear()
    // The bridge itself may be unloading with live sockets: the client is told
    // the endpoint is going away instead of being left on a dead protocol.
    this.#transport.close(1001, 'the bridge is going away')
  }

  async #dispatch(frame: ReqFrame): Promise<DispatchOutcome> {
    const builtIn = KNOWN_METHODS.has(frame.m)
    // A method no plugin registered is refused here, before the pairing gate, so
    // the answer costs no plugin lookup and names the method the client invented.
    if (!builtIn && this.#options.extensions?.has(frame.m) !== true) {
      return refusal(CODE_UNKNOWN_METHOD, `unknown method ${frame.m}`)
    }
    // `question.answer` exists only for a client that asked for the question
    // channel: without the capability it is an unknown method, which is exactly
    // what this frame was before the channel existed.
    if (frame.m === METHOD_QUESTION_ANSWER && !this.declares(CAP_QUESTIONS)) {
      return refusal(CODE_UNKNOWN_METHOD, `unknown method ${frame.m}`)
    }
    // `jobs.list` is the whole of the job channel: without the capability the
    // method does not exist, and without the method no scope is ever watched, so
    // a client that never declared it can receive no `jobs.changed` either.
    if (frame.m === METHOD_JOBS_LIST && !this.declares(CAP_JOBS)) {
      return refusal(CODE_UNKNOWN_METHOD, `unknown method ${frame.m}`)
    }
    // The agent channel is one capability: without `agents.v1` neither the preset
    // roster nor session creation is part of this client's protocol, so a client
    // that predates them is told what it was told before they existed.
    if ((frame.m === METHOD_PRESETS_LIST || frame.m === METHOD_SESSION_CREATE) && !this.declares(CAP_AGENTS)) {
      return refusal(CODE_UNKNOWN_METHOD, `unknown method ${frame.m}`)
    }
    // Unconditional: a loopback Host buys nothing here. Without a device token
    // only the handshake and the two pairing steps run.
    if (!this.paired && !UNPAIRED_METHODS.has(frame.m)) return refusal(CODE_UNPAIRED, 'this connection is not paired')
    // Extension methods run after both gates, so a registered name answers
    // `unpaired` exactly as a protocol method does, and a client that never
    // declared the capability is told the method does not exist rather than
    // that it lacks rights to it.
    if (!builtIn) return await this.#extension(frame)
    switch (frame.m) {
      case METHOD_HELLO: return this.#hello(frame.p)
      case METHOD_PAIR_BEGIN: return this.#pairBegin(frame.p)
      case METHOD_PAIR_FINISH: return await this.#pairFinish(frame.p)
      case METHOD_SESSION_LIST: return await this.#sessionList(frame.p)
      case METHOD_SESSION_TITLES: return this.#sessionTitles(frame.p)
      case METHOD_SESSION_SNAPSHOT: return await this.#sessionSnapshot(frame.p, frame.id)
      case METHOD_SESSION_HISTORY: return await this.#sessionHistory(frame.p, frame.id)
      case METHOD_SESSION_HISTORY_DEEP: return await this.#sessionHistoryDeep(frame.p, frame.id)
      case METHOD_SESSION_PROMPT: return await this.#sessionPrompt(frame.p)
      case METHOD_SESSION_INTERRUPT: return await this.#sessionInterrupt(frame.p)
      case METHOD_SESSION_ATTACHMENT: return await this.#sessionAttachment(frame.p, frame.id)
      case METHOD_SESSION_PERMISSIONS: return this.#sessionPermissions(frame.p)
      case METHOD_SESSION_SET_PERMISSION: return this.#sessionSetPermission(frame.p)
      case METHOD_SESSION_MODELS: return await this.#sessionModels(frame.p)
      case METHOD_SESSION_SET_MODEL: return await this.#sessionSetModel(frame.p)
      case METHOD_APPROVAL_RESOLVE: return this.#approvalResolve(frame.p)
      case METHOD_QUESTION_ANSWER: return await this.#questionAnswer(frame.p)
      case METHOD_JOBS_LIST: return await this.#jobsList(frame.p)
      case METHOD_PRESETS_LIST: return await this.#presetsList()
      case METHOD_SESSION_CREATE: return await this.#sessionCreate(frame.p)
      default: return refusal(CODE_UNKNOWN_METHOD, `unknown method ${frame.m}`)
    }
  }

  /**
   * Run one method a plugin registered on the extension seam.
   *
   * The plugin decides everything: whether the payload is usable, what an
   * answer looks like, and which refusal codes exist in its own protocol. This
   * bridge only forwards — and owns `internal`, because a handler that throws
   * or answers nothing usable has left the client with no other honest code.
   * @param frame - the request being served.
   */
  async #extension(frame: ReqFrame): Promise<DispatchOutcome> {
    const handler = this.#options.extensions?.handlerFor(frame.m, capability => this.declares(capability))
    // Reached when the name is registered but this client never declared the
    // capability: the method is not part of its protocol.
    if (handler === undefined) return refusal(CODE_UNKNOWN_METHOD, `unknown method ${frame.m}`)
    try {
      const result = await handler(frame.p, {
        connectionId: this.#id,
        declares: capability => this.declares(capability),
        deltas: this.#deltas,
      })
      if (!isMethodResult(result)) return refusal(CODE_INTERNAL, `${frame.m} answered no result`)
      return result.ok ? { ok: true, r: result.r } : refusal(result.code, result.msg)
    } catch (error) {
      // The plugin's own message is the diagnostic; the client is told the call
      // failed in this bridge because no extension code would be truthful here.
      this.#options.log(`${frame.m} failed: ${failureText(error)}`)
      return refusal(CODE_INTERNAL, failureText(error))
    }
  }

  #hello(payload: Readonly<Record<string, unknown>>): DispatchOutcome {    const proto = payload.proto
    if (proto !== PROTO) return refusal(CODE_PROTO_UNSUPPORTED, `this bridge speaks protocol ${PROTO}`)
    this.#capabilities = capabilitiesOf(payload.cap)
    // The frame form is decided where the frame is written, so the carrier is
    // told the one thing it cannot read for itself: what this peer can inflate.
    this.#transport.frameDeflate?.(this.#capabilities.has(CAP_FRAME_DEFLATE))
    // The hub replays anything this client can now receive but missed: a phone
    // that connected after a question was raised has no other way to learn of it.
    this.#options.onDeclare?.(this)
    return {
      ok: true,
      r: {
        proto: PROTO,
        minor: MINOR,
        server: SERVER_ID,
        capabilities: [...SERVED_CAPABILITIES],
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

  /**
   * Answer the roster as a whole set, or as the increment since a token.
   *
   * `since` and the two answer modes exist only for a client that declared
   * {@link CAP_DELTA}: every other client is answered the roster it always was,
   * with `mode:"reset"` and an empty `token` beside it, and this connection
   * keeps no copy of a set that client cannot continue from.
   * @param payload - `{since?}`.
   */
  async #sessionList(payload: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const roster = await this.#readRoster()
    if (!roster.ok) return roster
    if (!this.declares(CAP_DELTA)) {
      this.#deltas.drop('session.list')
      return { ok: true, r: { mode: 'reset', token: '', sessions: roster.rows } }
    }
    const answer = this.#deltas
      .window<SessionRow>('session.list', { maxRows: ROSTER_DELTA_MAX_ROWS })
      .answer(roster.rows, sinceOf(payload))
    return {
      ok: true,
      r: answer.mode === 'reset'
        ? { mode: 'reset', token: answer.token, sessions: answer.rows }
        : { mode: 'delta', token: answer.token, changed: answer.changed, removed: answer.removed },
    }
  }

  /**
   * Read the roster once, as the host answers it.
   *
   * Deliberately separate from {@link #sessionList}: lineage and authorization
   * are learned from the same read, and an internal read must not consume or
   * advance this connection's incremental base.
   */
  async #readRoster(): Promise<{ readonly ok: true; readonly rows: SessionRow[] } | CallFailure> {
    const call = await this.#unary('session', 'list')
    if (!call.ok) return call
    const items = isRecord(call.value) ? call.value.items : undefined
    if (!Array.isArray(items)) return refusal(CODE_INTERNAL, 'session/list returned no item table')
    // Read once for the whole roster: the archive flag comes from one process-wide
    // set, and an unreadable registry leaves the key out of every row — and drops
    // nothing, because a bridge that cannot tell must not answer a shorter roster.
    // A row that survives therefore always carries `archived: false`: the key stays
    // in the schema even though no `true` crosses it any more.
    const archived = this.#options.sessionMeta.archiveSet()
    const sessions: SessionRow[] = []
    for (const item of items) {
      if (!isRecord(item) || typeof item.sessionId !== 'string') continue
      // An archived session is not part of the roster this connection is sent at
      // all: the phone hides such a row on arrival, so sending it is bytes paid
      // for nothing. Skipped before the row is built, so no field of it is read.
      // A live child keeps its own row, and with it the parent id that row names,
      // so an archived parent never costs a child its lineage; the follow gate
      // does notice, because that parent is no longer a session the roster names.
      if (archived?.has(item.sessionId) === true) continue
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
    return { ok: true, rows: sessions }
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

  /**
   * Answer `session.snapshot`: the opening window, or one page of it.
   *
   * A client that declared {@link CAP_SESSION_SNAPSHOT_PAGE} gets the newest
   * page inside `maxBytes` (default {@link HISTORY_PAGE_BYTES}) instead of the
   * whole window, so an opening screen costs one page. The page is cut by the
   * same entry-level slice `session.history` uses, so the two can never
   * disagree, an entry larger than the whole budget is a page of its own rather
   * than a refusal, and `snapshot-too-large` cannot answer such a connection.
   * The oldest entry's own `seq` is the `before` cursor for the next, older
   * page; no second field restates it.
   * @param payload - `{sessionId, maxBytes?}`.
   * @param id - the request id the page budget is measured against.
   */
  async #sessionSnapshot(payload: Readonly<Record<string, unknown>>, id: number): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    if (sessionId === undefined) return refusal(CODE_INVALID_ARGS, 'session.snapshot requires sessionId')
    const unfollowable = await this.#unfollowable(sessionId)
    if (unfollowable !== undefined) return refusal(CODE_SESSION_NOT_FOLLOWABLE, unfollowable)
    const opening = await this.#awaitOpening(this.#ensureSubscription(sessionId))
    if (!opening.ok) return refusal(opening.code, `session ${sessionId} produced no opening frame (${opening.msg})`)
    // A client that declared the trim capability chooses what it is sent, never
    // which turns it gets: the projection is trimmed inside each turn first, and
    // only then does any frame or page budget apply.
    const projection = this.#projectionOf(opening.baseline.records)
    if (!this.#capabilities.has(CAP_SESSION_SNAPSHOT_PAGE)) {
      // Not declared: the whole window, shrunk by whole turns, unchanged.
      const fitted = this.#fitTurns(projection, opening.baseline.cursor, id)
      if (fitted === undefined) return refusal(CODE_SNAPSHOT_TOO_LARGE, `session ${sessionId} does not fit one ${MAX_FRAME_BYTES} byte frame`)
      return { ok: true, r: { turns: fitted.turns, lastSeq: fitted.lastSeq } }
    }
    const budget = pageBudgetOf(payload.maxBytes, METHOD_SESSION_SNAPSHOT)
    if (!budget.ok) return budget
    const lastSeq = opening.baseline.cursor
    const page = pageTurns(projection, undefined, budget.maxBytes, (turns, _nextBefore, hasMore) =>
      Buffer.byteLength(JSON.stringify(responseFrame(id, { turns, lastSeq, hasMore })), 'utf8'))
    return { ok: true, r: { turns: page.turns, lastSeq, hasMore: page.hasMore } }
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
    const budget = pageBudgetOf(payload.maxBytes, METHOD_SESSION_HISTORY)
    if (!budget.ok) return budget
    const unfollowable = await this.#unfollowable(sessionId)
    if (unfollowable !== undefined) return refusal(CODE_SESSION_NOT_FOLLOWABLE, unfollowable)
    const opening = await this.#awaitOpening(this.#ensureSubscription(sessionId))
    if (!opening.ok) return refusal(opening.code, `session ${sessionId} produced no opening frame (${opening.msg})`)
    const page = pageTurns(this.#projectionOf(opening.baseline.records), before, budget.maxBytes, (turns, nextBefore, hasMore) =>
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

  /**
   * Read one backwards page of a session's DURABLE history.
   *
   * `session.history` slices the follow window this connection holds, and that
   * window is only as wide as the harness was asked to open it (200 messages), so
   * a client that scrolls past it has no older page to ask for. This method reads
   * the session store itself: one `session/page` call walked backwards with
   * `beforeSeq`, with no follow stream and no window involved.
   *
   * It is a pure read in the same sense `session.history` is: nothing is
   * subscribed, remembered, dropped or re-addressed, so the same `before`
   * answers the same page and reading cannot change what the session is.
   * @param payload - `{sessionId, before?, maxBytes?}`.
   * @param id - the request id the page budget is measured against.
   */
  async #sessionHistoryDeep(payload: Readonly<Record<string, unknown>>, id: number): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    if (sessionId === undefined) return refusal(CODE_INVALID_ARGS, 'session.history.deep requires sessionId')
    const before = payload.before === undefined ? undefined : pageNumber(payload.before)
    if (payload.before !== undefined && before === undefined) {
      return refusal(CODE_INVALID_ARGS, 'session.history.deep before must be a non-negative integer')
    }
    const budget = pageBudgetOf(payload.maxBytes, METHOD_SESSION_HISTORY_DEEP)
    if (!budget.ok) return budget
    // The same fence every other history read passes, and it runs before any
    // store call: a child this connection may not read costs no read at all.
    const unfollowable = await this.#unfollowable(sessionId)
    if (unfollowable !== undefined) return refusal(CODE_SESSION_NOT_FOLLOWABLE, unfollowable)
    const cut = await this.#durableCutOf(sessionId)
    if (!cut.ok) return cut
    const store = await this.#storePageOf(sessionId, cut.cut, before)
    if (!store.ok) return store
    const projection = turnsOfRecords(store.records)
    const oldestOf = (turns: readonly SnapshotTurn[]): number | undefined => turns[0]?.entries[0]?.seq
    const page = pageTurns(projection, before, budget.maxBytes, (turns, nextBefore, hasMore) => {
      // The measured frame is the ANSWER, not the store read: a store page that
      // ends short of the session's oldest entry still leaves older entries
      // behind the answer, and the cursor is the answer's own oldest entry.
      const more = hasMore || store.hasMore
      const cursor = more ? nextBefore ?? oldestOf(turns) : undefined
      return Buffer.byteLength(JSON.stringify(responseFrame(id, {
        turns,
        ...(cursor === undefined ? {} : { nextBefore: cursor }),
        hasMore: more,
      })), 'utf8')
    })
    if (page.turns.length === 0) return { ok: true, r: { turns: [], hasMore: false } }
    const hasMore = page.hasMore || store.hasMore
    const nextBefore = page.nextBefore ?? oldestOf(page.turns)
    return {
      ok: true,
      r: {
        turns: page.turns,
        ...(hasMore && nextBefore !== undefined ? { nextBefore } : {}),
        hasMore,
      },
    }
  }

  /**
   * The inclusive log cut one durable page read names.
   *
   * `session/page` takes that cut as `throughSeq` and refuses one the store does
   * not hold, so a page read has to name a seq the session actually has. The
   * projection watermark is that seq: the cut every finished projection value has
   * folded through, read from the non-activating projection service
   * `session.models` already uses. `-1` is the harness's own name for a log with
   * no events at all, and the store answers it with an empty page.
   */
  async #durableCutOf(sessionId: string): Promise<{ readonly ok: true; readonly cut: number } | CallFailure> {
    const call = await this.#unary('session', 'projections', { sessionId })
    if (!call.ok) return call
    const cut = isRecord(call.value) ? call.value.asOfSeq : undefined
    if (typeof cut !== 'number' || !Number.isSafeInteger(cut) || cut < -1) {
      return refusal(CODE_SNAPSHOT_UNAVAILABLE, `session ${sessionId} reported no durable cut to page from`)
    }
    return { ok: true, cut }
  }

  /**
   * Read one span of a session's durable history, at the address the harness demands.
   *
   * A delegated child is addressable only through its durable parent, and the
   * harness answers `session/agent-busy` when it is asked as an ordinary session.
   * That refusal is the one signal that distinguishes it from a real failure, so
   * it is the only one that triggers the roster lookup and the retry — the same
   * resolution {@link #openSubscription} performs for the follow stream.
   */
  async #storePageOf(sessionId: string, cut: number, before: number | undefined): Promise<{ readonly ok: true; readonly records: readonly unknown[]; readonly hasMore: boolean } | CallFailure> {
    let call = await this.#pageCall(this.#addressOf(sessionId), cut, before)
    if (!call.ok && call.code === CODE_SUBAGENT_ADDRESS_REQUIRED) {
      const parent = await this.#parentOf(sessionId)
      if (parent === undefined) return call
      this.#lineage.set(sessionId, parent)
      call = await this.#pageCall(subagentAddress(parent, sessionId), cut, before)
    }
    if (!call.ok) return call
    const value = call.value
    const records = isRecord(value) && Array.isArray(value.records) ? value.records as readonly unknown[] : undefined
    if (records === undefined) return refusal(CODE_INTERNAL, 'session/page answered no records')
    return { ok: true, records, hasMore: isRecord(value) && value.hasMore === true }
  }

  /** One `session/page` call at one resolved address. */
  async #pageCall(address: SessionAddress, cut: number, before: number | undefined) {
    return await this.#unary('session', 'page', {
      address,
      throughSeq: cut,
      ...(before === undefined ? {} : { beforeSeq: before }),
      ...DEEP_HISTORY_WINDOW,
    })
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
    // Attachments are settled before the receipt is read and before anything is
    // sent: one rejected attachment withholds the whole prompt, so the harness is
    // not even subscribed to, let alone prompted.
    const attachments = promptAttachmentsOf(payload.attachments)
    if (!attachments.ok) return attachments
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
      content: [{ type: 'text', text }, ...attachments.parts],
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

  /**
   * Answer `session.attachment`: one durable image's bytes, straight from the
   * harness.
   *
   * The bridge keeps no cache — an image can be offloaded after the fact, so
   * every read goes to the session it belongs to — and it refuses rather than
   * writing a frame past the envelope budget: an attachment that cannot cross at
   * all is reported as such, never as an absent attachment.
   * @param payload - `{sessionId, attachmentId}`.
   * @param id - the request id the frame budget is measured against.
   */
  async #sessionAttachment(payload: Readonly<Record<string, unknown>>, id: number): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    const attachmentId = stringArg(payload, 'attachmentId')
    if (sessionId === undefined || attachmentId === undefined) {
      return refusal(CODE_INVALID_ARGS, 'session.attachment requires sessionId and attachmentId')
    }
    const call = await this.#unary('session', 'attachment', { sessionId, attachmentId })
    if (!call.ok) return call
    if (!isRecord(call.value)) return refusal(CODE_INTERNAL, 'session/attachment returned no attachment')
    const bytes = Buffer.byteLength(JSON.stringify(responseFrame(id, call.value)), 'utf8')
    if (bytes > MAX_FRAME_BYTES) {
      return refusal(FRAME_TOO_LARGE, `attachment ${attachmentId} needs ${bytes} bytes, past the ${MAX_FRAME_BYTES} byte frame`)
    }
    return { ok: true, r: call.value }
  }

  /** Answer `session.permissions` out of the host's own preset service. */
  #sessionPermissions(payload: Readonly<Record<string, unknown>>): DispatchOutcome {
    const sessionId = stringArg(payload, 'sessionId')
    if (sessionId === undefined) return refusal(CODE_INVALID_ARGS, 'session.permissions requires sessionId')
    const answer = this.#options.permissions.describe(sessionId)
    return 'code' in answer ? refusal(answer.code, answer.msg) : { ok: true, r: answer }
  }

  /**
   * Switch one session's permission mode.
   *
   * This is the session-level persistent mode, deliberately apart from
   * `approval.resolve`: that answers one tool question once, this changes what
   * every later turn runs under.
   */
  #sessionSetPermission(payload: Readonly<Record<string, unknown>>): DispatchOutcome {
    const sessionId = stringArg(payload, 'sessionId')
    const id = stringArg(payload, 'id')
    if (sessionId === undefined || id === undefined) {
      return refusal(CODE_INVALID_ARGS, 'session.setPermission requires sessionId and id')
    }
    const answer = this.#options.permissions.set(sessionId, id)
    return 'code' in answer ? refusal(answer.code, answer.msg) : { ok: true, r: { ok: true, current: answer.current } }
  }

  /**
   * Answer `session.models`: the host's catalog plus this session's selection.
   *
   * `current` is the session's FOLD — next, else last used, else the catalog
   * default — and never the default on its own: a phone that showed the default
   * while another model was in force would name the wrong model for the next
   * turn. The catalog's groups, failures and default cross unchanged.
   * @param payload - `{sessionId}`.
   */
  async #sessionModels(payload: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    if (sessionId === undefined) return refusal(CODE_INVALID_ARGS, 'session.models requires sessionId')
    const catalog = await this.#unary('session', 'modelCatalog')
    if (!catalog.ok) return catalog
    if (!isRecord(catalog.value)) return refusal(CODE_INTERNAL, 'session/modelCatalog returned no catalog')
    const fallback = selectionOf(catalog.value.default)
    if (fallback === undefined) return refusal(CODE_INTERNAL, 'session/modelCatalog returned no default model')
    const projections = await this.#unary('session', 'projections', { sessionId })
    if (!projections.ok) return projections
    const folded = modelSelectionOf(projections.value)
    return {
      ok: true,
      r: {
        current: folded.next ?? folded.lastUsed ?? fallback,
        default: fallback,
        groups: catalog.value.groups ?? [],
        failures: catalog.value.failures ?? [],
      },
    }
  }

  /**
   * Answer `session.setModel`: register the next turn's selection.
   *
   * The harness only records the choice for the NEXT request, so the answer
   * echoes the `selected` selection it accepted and nothing here claims the
   * running turn changed.
   * @param payload - `{sessionId, provider, model, effort?}`.
   */
  async #sessionSetModel(payload: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    const provider = stringArg(payload, 'provider')
    const model = stringArg(payload, 'model')
    if (sessionId === undefined || provider === undefined || model === undefined) {
      return refusal(CODE_INVALID_ARGS, 'session.setModel requires sessionId, provider and model')
    }
    const effort = optionalText(payload.effort)
    const call = await this.#unary('session', 'selectModel', {
      sessionId,
      provider,
      model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    })
    if (!call.ok) return call
    const selected = isRecord(call.value) ? selectionOf(call.value.selected) : undefined
    if (selected === undefined) return refusal(CODE_INTERNAL, 'session/selectModel returned no selected model')
    return { ok: true, r: { ok: true, current: selected } }
  }

  /**
   * Answer `presets.list`: the host's Agent-preset roster, forwarded verbatim.
   *
   * The bridge has no vocabulary of its own for a preset — a row is whatever
   * `agentPresets/list` publishes, and that endpoint takes no request — so the
   * answer crosses exactly as the host wrote it, down to the keys a client of
   * this version does not read.
   */
  async #presetsList(): Promise<DispatchOutcome> {
    const call = await this.#unary('agentPresets', 'list')
    return call.ok ? { ok: true, r: call.value } : call
  }

  /**
   * Answer `session.create`: hand the client's request to the host unchanged.
   *
   * A preset instantiated as an Agent is a host decision about a body this
   * bridge does not model — the field names, the defaults and the refusals
   * belong to `SessionCreateRequest` and to the host that validates it — so the
   * payload and the answer cross verbatim. Nothing is required here, renamed, or
   * defaulted: a request the host rejects is rejected with the host's own code
   * and text.
   * @param request - the host's `SessionCreateRequest`, exactly as the client wrote it.
   */
  async #sessionCreate(request: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const call = await this.#unary('session', 'create', request)
    return call.ok ? { ok: true, r: call.value } : call
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
   * Answer one pending user question.
   *
   * The claim decides how the answer travels: an open question settles the
   * host's own ask, a continued one is steered into the agent through the
   * host's Remote `answer`. A call id this bridge does not hold is refused
   * rather than forwarded, and a host failure crosses with its own code.
   * @param payload - `{sessionId, callId, answers}`.
   */
  async #questionAnswer(payload: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const sessionId = stringArg(payload, 'sessionId')
    const callId = stringArg(payload, 'callId')
    const answers = answersOf(payload.answers)
    if (sessionId === undefined || callId === undefined || answers === undefined) {
      return refusal(CODE_INVALID_ARGS, 'question.answer requires sessionId, callId and answers of {id, selected, custom?}')
    }
    const reply = await this.#options.questions.answer(sessionId, callId, { answers })
    return reply.ok ? { ok: true, r: { ok: true } } : refusal(reply.code, reply.msg)
  }

  /**
   * Answer one `jobs.list` and start watching that scope.
   *
   * The scope is the host registry's own: naming a session reads that session's
   * fenced set (its own jobs plus every unowned one), naming none reads the
   * unowned set. Neither is a global list, and this method never assembles one —
   * a cross-session view would be a second source of truth the host does not
   * have, and it would have to aggregate N fenced reads to fake it.
   *
   * Answering is also what subscribes: every later change of this scope arrives
   * as `jobs.changed` carrying the same payload, and a scope that was never
   * listed is never watched.
   * @param payload - `{}` for the unowned scope, or `{sessionId}` for one session's.
   */
  async #jobsList(payload: Readonly<Record<string, unknown>>): Promise<DispatchOutcome> {
    const raw = payload.sessionId
    if (raw !== undefined && (typeof raw !== 'string' || raw === '')) {
      return refusal(CODE_INVALID_ARGS, 'jobs.list sessionId must be a non-empty string when present')
    }
    const sessionId = raw
    if (sessionId !== undefined) {
      // A job row names its owner and carries its label, so this read is fenced
      // by the same rule as following the session it belongs to: a delegated
      // child whose parent this connection may not read is not addressable here.
      const unfollowable = await this.#unfollowable(sessionId)
      if (unfollowable !== undefined) return refusal(CODE_SESSION_NOT_FOLLOWABLE, unfollowable)
    }
    const roster = this.#options.jobs.read(sessionId)
    if (roster === undefined) {
      return refusal(CODE_JOBS_UNAVAILABLE, 'this host composes no background job registry')
    }
    this.#watchJobs(sessionId, roster)
    return { ok: true, r: roster }
  }

  /**
   * Watch one job scope for this connection, once.
   *
   * The scope's first payload is the answer the client just received, so it is
   * seeded as already seen: a change frame only ever carries a set that differs
   * from the last one this connection was handed.
   */
  #watchJobs(sessionId: string | undefined, payload: JobsPayload): void {
    const key = scopeKey(sessionId)
    this.#jobSeen.set(key, JSON.stringify(payload.jobs))
    if (this.#jobWatches.has(key)) return
    const dispose = this.#options.jobs.watch(sessionId, (changed) => {
      if (!this.declares(CAP_JOBS)) return
      const encoded = JSON.stringify(changed.jobs)
      if (this.#jobSeen.get(key) === encoded) return
      this.#jobSeen.set(key, encoded)
      this.#emit(TOPIC_JOBS_CHANGED, changed)
    })
    if (dispose !== undefined) this.#jobWatches.set(key, dispose)
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
        peer: this.#options.ownerPeer,
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

  /**
   * Remember the durable parent of every delegated child a roster carried, and
   * which sessions that same roster authorizes this connection to read.
   *
   * A child is not authorized by being named: authorizing it on its own row
   * would let one refused read teach the connection to follow it on the retry.
   */
  #rememberLineage(rows: readonly SessionRow[]): void {
    for (const row of rows) {
      if (row.origin !== 'subagent') {
        this.#authorized.add(row.id)
        continue
      }
      if (row.parentSessionId !== undefined) this.#lineage.set(row.id, row.parentSessionId)
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
    const roster = await this.#readRoster()
    if (roster.ok) this.#lineageRead = true
    return this.#lineage.get(sessionId)
  }

  /**
   * Whether this connection may follow one session at all.
   *
   * Following a delegated child is the one case that needs an answer before the
   * stream is asked for: relaxing the child gate must not become a channel to
   * any session a caller happens to name. A session this connection already
   * opened is authorized by that fact, an ordinary session the roster names is
   * authorized by the host's own roster, and a delegated child is authorized
   * only when the parent it hangs off is one of those. A session the roster does
   * not know at all keeps the old path — the harness itself answers for an id
   * this host does not have.
   * @returns the refusal to answer with, or undefined when the session may be followed.
   */
  async #unfollowable(sessionId: string): Promise<string | undefined> {
    if (this.#authorized.has(sessionId)) return undefined
    const parent = await this.#parentOf(sessionId)
    if (parent === undefined) return undefined
    if (this.#authorized.has(parent)) return undefined
    return `session ${sessionId} is a delegated child whose parent ${parent} is not a session this connection may read`
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
        peer: this.#options.ownerPeer,
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
      // A stream that opened is proof this connection may read that session,
      // which is what lets a child of it be followed afterwards.
      this.#authorized.add(subscription.sessionId)
      void this.#drain(subscription, iterator)
      return { ok: true, baseline }
    } catch (error) {
      return { ok: false, code: errorCodeOf(error, CODE_SNAPSHOT_UNAVAILABLE), msg: failureText(error) }
    }
  }

  /** Consume the rest of a follow stream, publishing every increment. */
  async #drain(subscription: Subscription, iterator: AsyncIterator<unknown>): Promise<void> {
    // Turn and step belong to this stream, not to the connection: a phone
    // following a parent and a child at once interleaves two turn sequences.
    const memory = {
      subagentThread: this.declares(CAP_SUBAGENT_THREAD),
      spawnCalls: new SpawnCallIndex(),
    }
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) return
        const delta = deltaOfFollowFrame(next.value, this.#toolCalls, this.#messages, memory)
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
