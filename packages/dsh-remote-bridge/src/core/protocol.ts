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
export const METHOD_SESSION_PROMPT = 'session.prompt'
export const METHOD_SESSION_INTERRUPT = 'session.interrupt'
export const METHOD_PAIR_BEGIN = 'pair.begin'
export const METHOD_PAIR_FINISH = 'pair.finish'
export const METHOD_APPROVAL_RESOLVE = 'approval.resolve'

/** Server-pushed topics of protocol v1. */
export const TOPIC_SESSION_DELTA = 'session.delta'
export const TOPIC_APPROVAL_REQUEST = 'approval.request'

/**
 * Capability a client declares in `hello`'s `cap` array to ask for a trimmed
 * `session.snapshot` baseline. A client that does not declare it — including
 * every client written before this capability existed — is served exactly the
 * baseline protocol v1 always served.
 */
export const CAP_SESSION_SNAPSHOT_TRIM = 'session.snapshot.trim.v1'

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
  METHOD_SESSION_PROMPT,
  METHOD_SESSION_INTERRUPT,
  METHOD_PAIR_BEGIN,
  METHOD_PAIR_FINISH,
  METHOD_APPROVAL_RESOLVE,
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
export const CODE_SNAPSHOT_UNAVAILABLE = 'snapshot-unavailable'
export const CODE_SNAPSHOT_TOO_LARGE = 'snapshot-too-large'
export const CODE_INTERNAL = 'internal'

/** Protocol version this package speaks. */
export const PROTO = 1
/** Minor version this package speaks. */
export const MINOR = 0
/** `server` field of the hello response. */
export const SERVER_ID = 'dsh-remote-bridge'

/** Exact route path of the bridge's WebSocket endpoint. */
export const WS_PATH = '/ios/v1'
/** Exact route path of the loopback-only bootstrap token endpoint. */
export const PAIR_TOKEN_PATH = '/remote-bridge/pair/token'
