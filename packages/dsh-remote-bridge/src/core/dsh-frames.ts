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

/** One image a durable `user/message` carried, as far as a client renders it. */
export interface UserMessageAttachment {
  readonly attachmentId: string
  readonly mediaType: string
  readonly name?: string
}

/** Token usage one finished `assistant/message` reported, passed through unconverted. */
export interface MessageUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** One protocol v1 delta, before the session id and event sequence are attached. */
export type SessionDelta =
  | { readonly kind: 'text'; readonly text: string; readonly blockIndex: number }
  | { readonly kind: 'reasoning'; readonly text: string; readonly blockIndex: number }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly name: string; readonly argumentsDelta: string }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly output: string; readonly isError: boolean }
  | { readonly kind: 'turn-end'; readonly reason: string }
  | { readonly kind: 'user-message'; readonly text: string; readonly messageId?: string; readonly attachments?: readonly UserMessageAttachment[] }
  | { readonly kind: 'usage'; readonly usage: MessageUsage; readonly turn?: number; readonly step?: number }

/** Highest number of tool calls one connection remembers by id. */
export const TOOL_CALL_MEMORY = 512
/** Highest number of published user messages one connection remembers by id. */
export const USER_MESSAGE_MEMORY = 512

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
 * Remembers which durable user messages this connection already published.
 *
 * A client only ever appends a transcript, so one durable `user/message` must
 * reach the wire once: a replayed event would draw the same prompt a second
 * time. Bounded for the same reason {@link ToolCallIndex} is — a long-lived
 * connection must not grow with every message it ever saw.
 */
export class MessageIndex {
  readonly #ids = new Set<string>()

  /** @returns whether this message already contributed a delta. */
  has(id: string): boolean {
    return this.#ids.has(id)
  }

  /** Remember one message, evicting the oldest entry past {@link USER_MESSAGE_MEMORY}. */
  remember(id: string): void {
    this.#ids.add(id)
    while (this.#ids.size > USER_MESSAGE_MEMORY) {
      const oldest = this.#ids.values().next()
      if (oldest.done === true) break
      this.#ids.delete(oldest.value)
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
 * @param messages - this connection's published-user-message memory.
 */
export function deltaOfFollowFrame(frame: unknown, toolCalls: ToolCallIndex, messages: MessageIndex): SessionDelta | undefined {
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
  if (type === 'user/message') return userMessageDelta(data, messages)
  if (type === 'assistant/message') return usageDelta(data)
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
 * Map one durable `user/message` to the increment that shows it on a subscribed
 * phone, so a prompt typed on the desktop appears without a baseline reload.
 *
 * Published once per message id: a replayed event must not draw the message a
 * second time. The text is the message's text blocks and nothing else — image
 * and file blocks travel in `attachments`, never inside it.
 */
function userMessageDelta(data: unknown, messages: MessageIndex): SessionDelta | undefined {
  if (!isRecord(data)) return undefined
  const messageId = stringField(data, 'id')
  if (messageId !== undefined) {
    if (messages.has(messageId)) return undefined
    messages.remember(messageId)
  }
  const attachments = imageAttachmentsOf(data.content)
  return {
    kind: 'user-message',
    text: textOfBlocks(data.content),
    ...(messageId === undefined ? {} : { messageId }),
    ...(attachments.length === 0 ? {} : { attachments }),
  }
}

/**
 * The image references of one message's blocks, in content order.
 *
 * A durable image block nests its immutable reference under the block's own
 * `attachment` key, so the id and media type are read from the reference — the
 * block itself carries only its type and, once offloaded, that flag.
 */
function imageAttachmentsOf(content: unknown): UserMessageAttachment[] {
  if (!Array.isArray(content)) return []
  const attachments: UserMessageAttachment[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue
    const ref = block.attachment
    if (!isRecord(ref)) continue
    const attachmentId = stringField(ref, 'attachmentId')
    const mediaType = stringField(ref, 'mediaType')
    if (attachmentId === undefined || mediaType === undefined) continue
    const name = stringField(ref, 'name')
    attachments.push({ attachmentId, mediaType, ...(name === undefined || name === '' ? {} : { name }) })
  }
  return attachments
}

/**
 * Map one finished `assistant/message` to its usage increment, or to nothing.
 *
 * An event without `usage` publishes NO delta: absent is not zero, and a client
 * must never record a token count the harness did not report.
 */
function usageDelta(data: unknown): SessionDelta | undefined {
  if (!isRecord(data)) return undefined
  const usage = usageOf(data.usage)
  if (usage === undefined) return undefined
  const turn = numberOf(data.turn)
  const step = numberOf(data.step)
  return { kind: 'usage', usage, ...(turn === undefined ? {} : { turn }), ...(step === undefined ? {} : { step }) }
}

/** Read one `TokenUsage` verbatim; undefined when its two mandatory counters are not numbers. */
function usageOf(value: unknown): MessageUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = numberOf(value.inputTokens)
  const outputTokens = numberOf(value.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const totalTokens = numberOf(value.totalTokens)
  const cacheReadTokens = numberOf(value.cacheReadTokens)
  const cacheWriteTokens = numberOf(value.cacheWriteTokens)
  const reasoningTokens = numberOf(value.reasoningTokens)
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/** @returns a finite number field, or undefined. */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

/** One contiguous backwards page of a snapshot projection. */
export interface SnapshotPage {
  /** The turns this page carries, oldest first; each keeps its own turn-level fields. */
  readonly turns: SnapshotTurn[]
  /** Durable seq of this page's oldest entry: the cursor for the next, older page. */
  readonly nextBefore?: number
  readonly hasMore: boolean
}

/**
 * Slice one backwards page out of a projection, BY ENTRY rather than by turn.
 *
 * `before` is a durable watermark, not an index: the page carries the newest
 * entries whose `seq` is strictly below it, so a cursor stays meaningful across
 * connections and a projection that changed shape under it (a trimmed entry
 * that never reaches the client) cannot make a page skip or repeat data. The
 * turn list is rebuilt around exactly the entries in the page, each turn
 * keeping its own `seq`/`endSeq`/`reason`, so a turn may be split across pages.
 *
 * A single entry that exceeds the budget on its own is a page of its own: the
 * size rule never removes an entry, it only ends the page.
 * @param turns - the projection to page, in order.
 * @param before - exclusive durable watermark, or undefined for the newest page.
 * @param maxBytes - byte budget of the encoded page.
 * @param measure - exact encoded size of one page shape, owned by the caller.
 */
export function pageTurns(
  turns: readonly SnapshotTurn[],
  before: number | undefined,
  maxBytes: number,
  measure: (turns: readonly SnapshotTurn[], nextBefore: number | undefined, hasMore: boolean) => number,
): SnapshotPage {
  const flat: { readonly turn: SnapshotTurn; readonly entry: SnapshotEntry }[] = []
  for (const turn of turns) {
    for (const entry of turn.entries) {
      if (before === undefined || entry.seq < before) flat.push({ turn, entry })
    }
  }
  if (flat.length === 0) return { turns: [], hasMore: false }

  const shells = new Map<SnapshotTurn, number>()
  for (const item of flat) {
    if (!shells.has(item.turn)) shells.set(item.turn, Buffer.byteLength(JSON.stringify({ ...item.turn, entries: [] }), 'utf8'))
  }
  // Greedy from the newest entry on a conservative running estimate — every
  // entry and every contributing turn shell counted once — and then verified
  // against the real encoding, shrinking from the oldest side until it fits.
  let start = flat.length
  let estimate = 0
  const counted = new Set<SnapshotTurn>()
  for (let index = flat.length - 1; index >= 0; index -= 1) {
    const item = flat[index]
    if (item === undefined) break
    let cost = Buffer.byteLength(JSON.stringify(item.entry), 'utf8') + 1
    if (!counted.has(item.turn)) {
      counted.add(item.turn)
      cost += shells.get(item.turn) ?? 0
    }
    if (start < flat.length && estimate + cost > maxBytes) break
    estimate += cost
    start = index
  }
  for (;;) {
    const oldest = flat[start]?.entry.seq
    if (oldest === undefined) return { turns: [], hasMore: false }
    const page = groupEntries(flat.slice(start))
    const hasMore = start > 0
    if (flat.length - start === 1 || measure(page, hasMore ? oldest : undefined, hasMore) <= maxBytes) {
      return hasMore ? { turns: page, nextBefore: oldest, hasMore } : { turns: page, hasMore }
    }
    start += 1
  }
}

/** Rebuild the turn list around one contiguous run of entries. */
function groupEntries(items: readonly { readonly turn: SnapshotTurn; readonly entry: SnapshotEntry }[]): SnapshotTurn[] {
  const page: SnapshotTurn[] = []
  let current: SnapshotTurn | undefined
  let entries: SnapshotEntry[] = []
  for (const item of items) {
    if (current !== item.turn) {
      if (current !== undefined) page.push({ ...current, entries })
      current = item.turn
      entries = []
    }
    entries.push(item.entry)
  }
  if (current !== undefined) page.push({ ...current, entries })
  return page
}

function snapshotEntryOf(record: unknown): SnapshotEntry | undefined {
  const event = isRecord(record) ? record.event : undefined
  if (!isRecord(event)) return undefined
  if (typeof event.type !== 'string' || typeof event.seq !== 'number') return undefined
  return { seq: event.seq, time: typeof event.time === 'number' ? event.time : 0, type: event.type, data: event.data }
}
