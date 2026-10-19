/**
 * The frozen protocol surface: method names, topic names, refusal codes, and
 * the one authorization rule the dispatcher enforces before any method runs.
 * @module dsh-remote-bridge/core/protocol
 */

/** Client-callable methods of protocol v1. */
export const METHOD_HELLO = 'hello'
export const METHOD_SESSION_LIST = 'session.list'
export const METHOD_SESSION_TITLES = 'session.titles'
export const METHOD_SESSION_SNAPSHOT = 'session.snapshot'
export const METHOD_SESSION_HISTORY = 'session.history'
export const METHOD_SESSION_HISTORY_DEEP = 'session.history.deep'
export const METHOD_SESSION_PROMPT = 'session.prompt'
export const METHOD_SESSION_INTERRUPT = 'session.interrupt'
export const METHOD_SESSION_ATTACHMENT = 'session.attachment'
export const METHOD_SESSION_PERMISSIONS = 'session.permissions'
export const METHOD_SESSION_SET_PERMISSION = 'session.setPermission'
export const METHOD_SESSION_MODELS = 'session.models'
export const METHOD_SESSION_SET_MODEL = 'session.setModel'
export const METHOD_SESSION_CREATE = 'session.create'
export const METHOD_PRESETS_LIST = 'presets.list'
export const METHOD_PAIR_BEGIN = 'pair.begin'
export const METHOD_PAIR_FINISH = 'pair.finish'
export const METHOD_APPROVAL_RESOLVE = 'approval.resolve'
export const METHOD_QUESTION_ANSWER = 'question.answer'
export const METHOD_JOBS_LIST = 'jobs.list'

/** Server-pushed topics of protocol v1. */
export const TOPIC_SESSION_DELTA = 'session.delta'
export const TOPIC_APPROVAL_REQUEST = 'approval.request'
export const TOPIC_QUESTION_REQUEST = 'question.request'
export const TOPIC_JOBS_CHANGED = 'jobs.changed'

/**
 * Capability a client declares in `hello`'s `cap` array to ask for a trimmed
 * `session.snapshot` baseline. A client that does not declare it — including
 * every client written before this capability existed — is served exactly the
 * baseline protocol v1 always served.
 */
export const CAP_SESSION_SNAPSHOT_TRIM = 'session.snapshot.trim.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to have
 * `session.snapshot` answer with one bounded page instead of the whole opening
 * window. Declaring it is what makes an opening screen cost one page rather
 * than a whole session; a client that does not declare it — including every
 * client written before this capability existed — receives byte for byte the
 * snapshot protocol v1 always served.
 */
export const CAP_SESSION_SNAPSHOT_PAGE = 'session.snapshot.page.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to have
 * `session.snapshot` answer a reconnect with only what it missed.
 *
 * The declaration and the request's `sinceSeq` are what it takes together: a
 * snapshot that carries no `sinceSeq` is answered, byte for byte, the body
 * protocol v1 always served, whether or not the client declared this. Behind
 * both, the client names the durable `lastSeq` of a snapshot it already holds
 * and the answer is either that same reply in an incremental form —
 * `{turns, lastSeq, mode:"since", reset:false}` carrying only the entries above
 * that watermark — or a full baseline with `mode:"full"` and `reset:true`,
 * which is the one answer that tells a client to throw its copy away. The
 * estimate is only served when the bridge can PROVE nothing was lost: the
 * current follow window's oldest entry must sit at or below `sinceSeq + 1`, so a
 * window that has already scrolled past the watermark answers the baseline
 * instead of a delta with a hole in it. It exists because a reconnect on the
 * phone re-paid 0.86-1.06 s of baseline five times in one measured run.
 */
export const CAP_SESSION_SNAPSHOT_SINCE = 'session.snapshot.since.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to be shown the
 * host's pending user questions and to answer them with `question.answer`.
 *
 * Declaring it is what makes `question.request` reachable and what makes the
 * method part of that client's protocol at all: a client that does not declare
 * it — including every client written before this channel existed — receives no
 * such event, and its `question.answer` is refused as an unknown method,
 * exactly as that frame was refused before.
 */
export const CAP_QUESTIONS = 'questions.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to be handed the
 * approval questions this bridge is already holding for it.
 *
 * Unlike every channel capability beside it, this one gates a second delivery
 * rather than the channel: `approval.request` still reaches every paired
 * connection the moment a tool asks, exactly as it did before this name
 * existed, because gating the first broadcast would take approvals away from
 * every client written before the capability. What the declaration buys is the
 * replay — after a reconnect, or on a session screen opened late, the client is
 * handed the questions that are still waiting instead of a card it never saw.
 * Only a live claim is replayed: a question that was answered, that the bridge
 * timed out, or that was withdrawn with the last phone is gone from the claim
 * registry before the replay reads it.
 *
 * It is deliberately absent from {@link SERVED_CAPABILITIES}: that list is what
 * `hello` advertises as served, advertising a capability is a minor-version
 * addition (see {@link MINOR}), and this channel changes nothing a client can
 * observe in the handshake — no answer, no field and no method behind it. The
 * declaration is the whole switch, and the name reaches a client through this
 * bridge's own protocol documentation.
 */
export const CAP_APPROVALS = 'approvals.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to be told where a
 * message came from and that an agent spawned a child session.
 *
 * Declaring it is what makes the `subagent` delta part of that client's
 * protocol: a client that does not declare it — including every client written
 * before this channel existed — receives no such event, exactly as that frame
 * was dropped before. The `actor` of a `user-message` is not gated: it is an
 * additive field a client that does not read it ignores.
 */
export const CAP_SUBAGENT_THREAD = 'subagent.thread.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to see the host's
 * background jobs and to be told when the set changes.
 *
 * Declaring it is what makes `jobs.list` reachable, and `jobs.list` is the only
 * thing that opens a roster: a connection that declares this capability but
 * never asks for a scope receives no `jobs.changed` at all. A client that does
 * not declare it — including every client written before this channel existed —
 * receives no such event, and its `jobs.list` is refused as an unknown method,
 * exactly as that frame was refused before.
 */
export const CAP_JOBS = 'jobs.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to read the host's
 * Agent presets and to instantiate one as a session.
 *
 * Declaring it is what makes `presets.list` and `session.create` part of that
 * client's protocol at all: a client that does not declare it — including every
 * client written before this channel existed — is refused both as unknown
 * methods, exactly as those frames were refused before. Neither method is
 * called on a connection's behalf either, so a client that never asks sends the
 * host no request.
 */
export const CAP_AGENTS = 'agents.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to be answered with
 * byte-level increments instead of the whole roster or the whole board.
 *
 * Behind it, `session.list` and `board.snapshot` (the latter through the board
 * plugin, §15) accept an opaque `since` token and answer either the whole set
 * (`mode:"reset"`) or only what changed since the set that token names. A
 * client that does not declare it — including every client written before this
 * channel existed — is answered today's body plus the ignorable `mode` and
 * `token` keys, with `mode` always `"reset"`.
 */
export const CAP_DELTA = 'delta.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to be told that an
 * archived session is not in the roster at all.
 *
 * Unlike every capability beside it this one negotiates nothing: the bridge
 * never transfers an archived session, whether or not a client declares it, so
 * an older client simply receives the shorter roster it would have hidden
 * anyway. The name is an announcement of that fact, so a client can stop
 * filtering for itself: behind it, no `session.list` row is a session the
 * host's archive set names, a row that does survive still carries
 * `archived: false` under the same schema, and a live child of an archived
 * parent still crosses with its `parentSessionId` — the parent id, not the
 * parent row.
 */
export const CAP_ROSTER_OMITS_ARCHIVED = 'session.list.omit-archived.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to be answered a
 * compact roster it can page.
 *
 * The declaration alone changes nothing: a listing that carries none of the
 * compact parameters (`cwd`, `maxRows`, `after`) is answered exactly the body
 * protocol v1 always served, so a client can opt into the name before it
 * relies on any of it. Behind the parameters, a row drops its absolute `cwd`
 * unless the request asks for it, drops its `updatedAt` when this connection
 * already sent that id the same value, and a `maxRows`/`after` pair cuts the
 * roster into pages ordered most recent first. The roster is the most repeated
 * large reply on the link, so this is what lets a reconnect pay for the newest
 * screenful plus a cursor instead of the whole list again.
 */
export const CAP_ROSTER_COMPACT = 'session.list.compact.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to be told that this
 * bridge can page a session's durable history down to its oldest entry.
 *
 * The capability is an announcement and nothing more. `session.history.deep` is
 * open to every paired connection, exactly as `session.history` is, because it
 * is a pure read of the session store that costs no other client anything;
 * declaring the capability is how a client learns the method exists, and a
 * client that does not declare it loses only that knowledge.
 */
export const CAP_SESSION_DEEP_HISTORY = 'session.deep-history.v1'

/**
 * Capability a client declares in `hello`'s `cap` array to be sent frames
 * compressed instead of as plain text.
 *
 * Declaring it is what allows the host to compress at all: a frame whose JSON
 * text is at least 1024 UTF-8 bytes crosses as one WebSocket binary frame
 * carrying raw DEFLATE (RFC 1951) of exactly that text, and a frame that does
 * not get smaller still crosses as the text frame it always was. A client that
 * does not declare it — including every client written before this capability
 * existed — receives byte for byte the text frames protocol v1 always wrote.
 *
 * The direction is one way: a client still sends text frames only, and the
 * 10 MiB frame cap stays measured on the text, before inflation.
 */
export const CAP_FRAME_DEFLATE = 'frame.deflate.v1'

/**
 * Methods an unpaired connection may still call: the handshake itself and the
 * two pairing steps. Everything else answers `unpaired` — a caller can pair
 * without a device token, but cannot touch a session without one.
 */
export const UNPAIRED_METHODS: ReadonlySet<string> = new Set([
  METHOD_HELLO,
  METHOD_PAIR_BEGIN,
  METHOD_PAIR_FINISH,
])

/** Every method this protocol version serves. */
export const KNOWN_METHODS: ReadonlySet<string> = new Set([
  METHOD_HELLO,
  METHOD_SESSION_LIST,
  METHOD_SESSION_TITLES,
  METHOD_SESSION_SNAPSHOT,
  METHOD_SESSION_HISTORY,
  METHOD_SESSION_HISTORY_DEEP,
  METHOD_SESSION_PROMPT,
  METHOD_SESSION_INTERRUPT,
  METHOD_SESSION_ATTACHMENT,
  METHOD_SESSION_PERMISSIONS,
  METHOD_SESSION_SET_PERMISSION,
  METHOD_SESSION_MODELS,
  METHOD_SESSION_SET_MODEL,
  METHOD_PAIR_BEGIN,
  METHOD_PAIR_FINISH,
  METHOD_APPROVAL_RESOLVE,
  METHOD_QUESTION_ANSWER,
  METHOD_JOBS_LIST,
  METHOD_PRESETS_LIST,
  METHOD_SESSION_CREATE,
])

/** Refusal codes the bridge itself raises (DSH failures cross as their own code). */
export const CODE_UNPAIRED = 'unpaired'
export const CODE_UNKNOWN_METHOD = 'unknown-method'
export const CODE_INVALID_ARGS = 'invalid-args'
export const CODE_PROTO_UNSUPPORTED = 'proto-unsupported'
export const CODE_TOKEN_INVALID = 'token-invalid'
export const CODE_NONCE_INVALID = 'nonce-invalid'
export const CODE_SIGNATURE_INVALID = 'signature-invalid'
export const CODE_APPROVAL_UNKNOWN = 'approval-unknown'
/**
 * The bridge does not hold the named question: it never claimed that call id, it
 * already answered it, or the host no longer holds it as answerable. Host
 * failures crossing this method keep their own codes instead.
 */
export const CODE_QUESTION_UNKNOWN = 'question-unknown'
/**
 * The named session is a delegated child whose durable parent is not a session
 * this connection may read. The bridge follows an addressable child and refuses
 * an unaddressable one, rather than reading it blind.
 */
export const CODE_SESSION_NOT_FOLLOWABLE = 'session-not-followable'
export const CODE_SNAPSHOT_UNAVAILABLE = 'snapshot-unavailable'
/**
 * This host composes no job registry, so it has no background jobs to publish.
 * The capability stays advertised — it is a fact about this bridge, not about
 * what a particular host mounts — and only a call that needs the registry fails.
 */
export const CODE_JOBS_UNAVAILABLE = 'jobs-unavailable'
export const CODE_SNAPSHOT_TOO_LARGE = 'snapshot-too-large'
export const CODE_INTERNAL = 'internal'

/** Protocol version this package speaks. */
export const PROTO = 1
/**
 * Minor version this package speaks.
 *
 * 10 when the snapshot became incremental on request: behind
 * {@link CAP_SESSION_SNAPSHOT_SINCE} a `session.snapshot` that names `sinceSeq`
 * is answered either the entries above that watermark or a full baseline
 * carrying `mode` and `reset`, so a client reads a new reply shape off the
 * wire and the number rises with it.
 * 9 when the compact roster shipped: behind {@link CAP_ROSTER_COMPACT} a
 * `session.list` that names one of the compact parameters is answered a
 * shorter row and may be cut into pages, so a client reads a new row schema
 * off the wire and the number rises with it.
 * 8 when the outbound frame form became a capability: behind
 * {@link CAP_FRAME_DEFLATE} a declaring client may be answered in binary
 * frames carrying raw DEFLATE of the text, so the minor is raised for a change
 * a client reads off the wire rather than for a name alone.
 * 7 when the two channels met: the agent channel and the durable history
 * channel each raised 5 to 6 on its own branch, so the protocol that carries
 * both is 7. 6 when the agent channel shipped: behind {@link CAP_AGENTS}
 * `presets.list` forwards the host's Agent-preset roster and `session.create`
 * hands the host one creation request, both verbatim. 6 was also the durable
 * history channel on its own: behind {@link CAP_SESSION_DEEP_HISTORY} a client
 * may call {@link METHOD_SESSION_HISTORY_DEEP} and walk a session's store back
 * to its oldest entry, below the follow window `session.history` slices. 5 when
 * the roster stopped carrying archived sessions: behind
 * {@link CAP_ROSTER_OMITS_ARCHIVED} `session.list` names no session the host's
 * archive set holds, so a session archived between two listings arrives as a
 * removal and one restored as a change. 4 when byte-level increments shipped:
 * behind {@link CAP_DELTA} `session.list` and `board.snapshot` answer a reset
 * or a delta against a `since` token. 3 was
 * the background-job channel — behind {@link CAP_JOBS} a client may call
 * `jobs.list` and receive `jobs.changed`. 2 was the subagent thread —
 * a `user-message` delta may carry an `actor` and a `subagent` delta exists
 * behind {@link CAP_SUBAGENT_THREAD}. 1 was the extension seam — a mounted
 * plugin may answer methods outside {@link KNOWN_METHODS} once the client
 * declares the capability that plugin requires. No addition changed the major
 * version, a frozen field, or an existing method or topic name.
 */
export const MINOR = 10

/**
 * The capabilities this bridge itself serves, as `hello` advertises them.
 *
 * A capability a mounted plugin adds is not listed here: the bridge cannot know
 * what it is not the author of. A client learns such a capability from the
 * plugin's own documentation, exactly as it did before this list existed.
 */
export const SERVED_CAPABILITIES: readonly string[] = [
  CAP_SESSION_SNAPSHOT_TRIM,
  CAP_SESSION_SNAPSHOT_PAGE,
  CAP_QUESTIONS,
  CAP_SUBAGENT_THREAD,
  CAP_JOBS,
  CAP_AGENTS,
  CAP_DELTA,
  CAP_ROSTER_OMITS_ARCHIVED,
  CAP_SESSION_DEEP_HISTORY,
  CAP_FRAME_DEFLATE,
  CAP_ROSTER_COMPACT,
  CAP_SESSION_SNAPSHOT_SINCE,
]
/** `server` field of the hello response. */
export const SERVER_ID = 'dsh-remote-bridge'

/** Exact route path of the bridge's WebSocket endpoint. */
export const WS_PATH = '/ios/v1'
/** Exact route path of the loopback-only bootstrap token endpoint. */
export const PAIR_TOKEN_PATH = '/remote-bridge/pair/token'
