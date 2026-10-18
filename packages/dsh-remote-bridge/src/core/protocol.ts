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
export const METHOD_SESSION_PROMPT = 'session.prompt'
export const METHOD_SESSION_INTERRUPT = 'session.interrupt'
export const METHOD_SESSION_ATTACHMENT = 'session.attachment'
export const METHOD_SESSION_PERMISSIONS = 'session.permissions'
export const METHOD_SESSION_SET_PERMISSION = 'session.setPermission'
export const METHOD_SESSION_MODELS = 'session.models'
export const METHOD_SESSION_SET_MODEL = 'session.setModel'
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
 * 3 when the background-job channel shipped: behind {@link CAP_JOBS} a client
 * may call `jobs.list` and receive `jobs.changed`. 2 was the subagent thread —
 * a `user-message` delta may carry an `actor` and a `subagent` delta exists
 * behind {@link CAP_SUBAGENT_THREAD}. 1 was the extension seam — a mounted
 * plugin may answer methods outside {@link KNOWN_METHODS} once the client
 * declares the capability that plugin requires. No addition changed the major
 * version, a frozen field, or an existing method or topic name.
 */
export const MINOR = 3

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
]
/** `server` field of the hello response. */
export const SERVER_ID = 'dsh-remote-bridge'

/** Exact route path of the bridge's WebSocket endpoint. */
export const WS_PATH = '/ios/v1'
/** Exact route path of the loopback-only bootstrap token endpoint. */
export const PAIR_TOKEN_PATH = '/remote-bridge/pair/token'
