/**
 * DSH session frames to protocol v1 `session.delta` payloads, plus the reverse
 * projection of a follow baseline into `session.snapshot` turns.
 *
 * Only frame SHAPES are read here, never DSH classes: the frame argument is
 * `unknown` and every field is narrowed structurally, so a cohort that adds a
 * field to a chunk cannot break the bridge and a cohort that renames one fails
 * loudly at the mapping instead of emitting a half-filled delta.
 * @module dsh-remote-bridge/core/dsh-frames
 */

/** One protocol v1 delta, before the session id and event sequence are attached. */
export type SessionDelta =
  | { readonly kind: 'text'; readonly text: string; readonly blockIndex: number }
  | { readonly kind: 'reasoning'; readonly text: string; readonly blockIndex: number }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly name: string; readonly argumentsDelta: string }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly output: string; readonly isError: boolean }
  | { readonly kind: 'turn-end'; readonly reason: string }

/** Highest number of tool calls one connection remembers by id. */
export const TOOL_CALL_MEMORY = 512

/**
 * The durable entry types a protocol v1 client renders — `user/message`,
 * `assistant/message`, `tool/call` and `tool/result`. Everything else in a
 * turn's entries is the harness's own bookkeeping, which the client can only
 * count as unknown, so a client that asks for a trimmed baseline is not sent it.
 */
export const RENDERED_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/** One raw durable event inside a snapshot turn. */
export interface SnapshotEntry {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

/** One turn of a session snapshot: the durable events from `turn/start` to `turn/end`. */
export interface SnapshotTurn {
  /** Seq of the `turn/start` event, or 0 for the lead-in before the first turn. */
  readonly seq: number
  readonly time: number
  /** Seq of the `turn/end` event, or 0 while the turn is still open. */
  readonly endSeq: number
  readonly endTime: number
  /** `turn/end` reason kind, or the empty string while the turn is open. */
  readonly reason: string
  readonly entries: readonly SnapshotEntry[]
}

/** The opening frame of a `session/follow` stream. */
export interface FollowBaseline {
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

/**
 * Remembers which tool calls have already streamed their arguments, so the
 * durable `tool/call` event that follows the stream is not replayed as a second
 * copy of the same arguments. Bounded: a long-lived connection must not grow
 * with every call it ever saw.
 */
export class ToolCallIndex {
  readonly #names = new Map<string, string>()

  /** @returns whether this call already contributed a delta. */
  has(callId: string): boolean {
    return this.#names.has(callId)
  }

  /** @returns the last name seen for this call, if any. */
  nameOf(callId: string): string | undefined {
    return this.#names.get(callId)
  }

  /** Remember one call, evicting the oldest entry past {@link TOOL_CALL_MEMORY}. */
  remember(callId: string, name: string): void {
    if (name !== '') this.#names.set(callId, name)
    else if (!this.#names.has(callId)) this.#names.set(callId, '')
    while (this.#names.size > TOOL_CALL_MEMORY) {
      const oldest = this.#names.keys().next()
      if (oldest.done === true) break
      this.#names.delete(oldest.value)
    }
  }
}

/**
 * Read the opening frame of a follow stream.
 * @returns the cursor and records, or undefined when this frame is not a snapshot.
 */
export function readFollowBaseline(frame: unknown): FollowBaseline | undefined {
  if (!isRecord(frame) || frame.type !== 'snapshot') return undefined
  const cursor = frame.cursor
  const records = frame.records
  if (typeof cursor !== 'number' || !Array.isArray(records)) return undefined
  return { cursor, records, hasMore: frame.hasMore === true }
}

/**
 * Map one DSH follow frame to a delta, or undefined when the frame carries no
 * increment this protocol publishes.
 * @param frame - one `SessionFollowFrame`.
 * @param toolCalls - this connection's tool-call memory.
 */
export function deltaOfFollowFrame(frame: unknown, toolCalls: ToolCallIndex): SessionDelta | undefined {
  if (!isRecord(frame)) return undefined
  if (frame.type === 'assistant-stream') return deltaOfAssistantStream(frame.frame, toolCalls)
  if (frame.type !== 'event') return undefined
  const event = frame.event
  if (!isRecord(event)) return undefined
  const type = event.type
  const data = event.data
  if (type === 'tool/result') return toolResultDelta(data)
  if (type === 'turn/end') return turnEndDelta(data)
  if (type === 'tool/call') return assembledToolCallDelta(data, toolCalls)
  return undefined
}

function deltaOfAssistantStream(frame: unknown, toolCalls: ToolCallIndex): SessionDelta | undefined {
  if (!isRecord(frame) || frame.type !== 'chunk') return undefined
  const chunk = frame.chunk
  if (!isRecord(chunk)) return undefined
  const index = typeof chunk.index === 'number' ? chunk.index : 0
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    return { kind: 'text', text: chunk.text, blockIndex: index }
  }
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
    return { kind: 'reasoning', text: chunk.text, blockIndex: index }
  }
  if (chunk.type === 'tool-call-delta' && typeof chunk.id === 'string' && chunk.id !== '') {
    const callId = chunk.id
    const announced = typeof chunk.name === 'string' && chunk.name !== '' ? chunk.name : undefined
    const name = announced ?? toolCalls.nameOf(callId) ?? ''
    toolCalls.remember(callId, name)
    return { kind: 'tool-call', callId, name, argumentsDelta: typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : '' }
  }
  return undefined
}

function toolResultDelta(data: unknown): SessionDelta | undefined {
  const message = isRecord(data) ? data.message : undefined
  if (!isRecord(message)) return undefined
  const callId = message.toolCallId
  if (typeof callId !== 'string' || callId === '') return undefined
  return { kind: 'tool-result', callId, output: textOfBlocks(message.content), isError: message.isError === true }
}

function turnEndDelta(data: unknown): SessionDelta | undefined {
  const reason = isRecord(data) ? data.reason : undefined
  const kind = isRecord(reason) ? reason.kind : undefined
  // An unreadable reason is reported as such: the client treats every non-
  // `completed` value as an abnormal end, and `unknown` is the truth here.
  return { kind: 'turn-end', reason: typeof kind === 'string' ? kind : 'unknown' }
}

/**
 * The durable `tool/call` event carries the WHOLE argument string, not an
 * increment, so it is published as a delta only when the connection never saw
 * this call's increments — otherwise the client would append the arguments a
 * second time.
 */
function assembledToolCallDelta(data: unknown, toolCalls: ToolCallIndex): SessionDelta | undefined {
  const callId = stringField(data, 'callId')
  if (callId === undefined || callId === '') return undefined
  if (toolCalls.has(callId)) return undefined
  const name = stringField(data, 'name') ?? ''
  toolCalls.remember(callId, name)
  return { kind: 'tool-call', callId, name, argumentsDelta: stringField(data, 'arguments') ?? '' }
}

/** Flatten a message's model-facing blocks to display text; non-text blocks are dropped. */
function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Project a follow baseline's records into turns.
 * @param records - the baseline's durable records, oldest first.
 * @returns one turn per `turn/start`, plus a lead-in turn when records precede the first one.
 */
export function turnsOfRecords(records: readonly unknown[]): SnapshotTurn[] {
  const turns: SnapshotTurn[] = []
  let current: { seq: number; time: number; endSeq: number; endTime: number; reason: string; entries: SnapshotEntry[] } | undefined
  for (const record of records) {
    const entry = snapshotEntryOf(record)
    if (entry === undefined) continue
    if (entry.type === 'turn/start' && current !== undefined && current.endSeq === 0) {
      // A previous turn never ended (an aborted resume): its tail stays with it.
      turns.push(current)
      current = undefined
    }
    if (current === undefined) {
      current = { seq: entry.type === 'turn/start' ? entry.seq : 0, time: entry.time, endSeq: 0, endTime: 0, reason: '', entries: [] }
    }
    current.entries.push(entry)
    if (entry.type === 'turn/end') {
      current.endSeq = entry.seq
      current.endTime = entry.time
      current.reason = isRecord(entry.data) && isRecord(entry.data.reason) && typeof entry.data.reason.kind === 'string'
        ? entry.data.reason.kind
        : 'unknown'
      turns.push(current)
      current = undefined
    }
  }
  if (current !== undefined && current.entries.length > 0) turns.push(current)
  return turns
}

/**
 * Drop the entries of each turn that a protocol v1 client would not render.
 *
 * Only the inside of a turn changes: which turns survive, their order, their
 * `seq`/`endSeq` metadata and every kept entry's `type` and `data` are the
 * projection's own output. A turn whose entries are all unrenderable stays as a
 * turn with an empty `entries` array, so the client never sees a shape it does
 * not know how to read.
 * @param turns - the projection of a follow baseline, in order.
 * @returns the same turns, each carrying only its rendered entries.
 */
export function trimUnrenderedEntries(turns: readonly SnapshotTurn[]): SnapshotTurn[] {
  return turns.map(turn => {
    const entries = turn.entries.filter(entry => RENDERED_ENTRY_TYPES.has(entry.type))
    return entries.length === turn.entries.length ? turn : { ...turn, entries }
  })
}

function snapshotEntryOf(record: unknown): SnapshotEntry | undefined {
  const event = isRecord(record) ? record.event : undefined
  if (!isRecord(event)) return undefined
  if (typeof event.type !== 'string' || typeof event.seq !== 'number') return undefined
  return { seq: event.seq, time: typeof event.time === 'number' ? event.time : 0, type: event.type, data: event.data }
}
