/**
 * Process-local session metadata the roster rows carry beyond the gateway's own
 * summary, and the cache that keeps a phone's title lookups off the title
 * service's hot path.
 *
 * Every read here goes to a service of the host process the bridge already runs
 * in, so nothing in this module opens a follow stream, waits on a socket or
 * touches persistence: a title is a synchronous read like a map lookup, which
 * is what makes a batch of them cheap enough to serve on request.
 *
 * The services are reached through structural faces rather than the SDK's own
 * service types, for the reason `wire.ts` states for the gateway: the live
 * objects carry far more than this package calls, and a face keeps a test
 * double down to what is actually read.
 * @module dsh-remote-bridge/core/session-meta
 */

import { failureText } from './gateway-errors.ts'

/** One live session, as far as the title service needs to see it. */
export interface LiveSessionFace {
  readonly id: string
}

/** The slice of `ctx.sessions` this package reads: the live session for an id. */
export interface SessionStoreFace {
  get(id: string): LiveSessionFace | undefined
}

/** The slice of `ctx.sessionTitle` this package reads. */
export interface SessionTitleFace {
  get(session: LiveSessionFace): { readonly title: string } | undefined
}

/** The slice of `ctx.workspaceRegistry` this package reads: the host's archive set. */
export interface ArchiveSetFace {
  readonly archivedSessionIds: readonly string[]
}

/**
 * The in-process services one metadata read may use.
 *
 * Every field is optional on purpose. The bridge does not require the title or
 * workspace plugins to be installed — the protocol's roster and title methods
 * stay answerable with them absent, and a field that is missing degrades one
 * key of one row instead of failing a method.
 */
export interface SessionMetaFaces {
  readonly sessions?: SessionStoreFace | undefined
  readonly titles?: SessionTitleFace | undefined
  readonly archive?: ArchiveSetFace | undefined
}

/** Largest id batch one `session.titles` call accepts. */
export const TITLES_MAX_IDS = 100
/** How long one resolved title is served before the service is asked again. */
export const TITLE_CACHE_TTL_MS = 10_000
/** How many ids the title cache remembers before the oldest entry is dropped. */
export const TITLE_CACHE_LIMIT = 512

/** One cached title and when it was read. */
interface CacheEntry {
  readonly title: string
  readonly at: number
}

/**
 * The bridge's session-metadata reads: live titles with a bounded cache, and
 * the host's archive set.
 *
 * One instance is built per host mount and shared by every connection, because
 * a title is a fact about the host's session, not about the device that asked.
 *
 * The cache is time-bounded rather than event-invalidated: a title change is a
 * `session/title` *log* event, which no cordis event announces, so an
 * invalidation hook would mean plumbing a listener into every live session. A
 * short TTL bounds how stale a served title can be while keeping the read off
 * the service for every repeat, and each batch call is itself a refresh point.
 */
export class SessionMeta {
  readonly #faces: () => SessionMetaFaces
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #ttlMs: number
  readonly #titles = new Map<string, CacheEntry>()

  /**
   * @param faces - resolves the host services now; called per read, never captured once, so a service that mounts later is still picked up.
   * @param now - the clock the cache window is measured on.
   * @param log - where a failed metadata read is reported.
   * @param ttlMs - cache window; the default is {@link TITLE_CACHE_TTL_MS}.
   */
  constructor(faces: () => SessionMetaFaces, now: () => number, log: (message: string) => void, ttlMs = TITLE_CACHE_TTL_MS) {
    this.#faces = faces
    this.#now = now
    this.#log = log
    this.#ttlMs = ttlMs
  }

  /**
   * Latest title this host knows for one session.
   *
   * Synchronous by construction: the title service folds titles out of the
   * session log it already holds. An id that is not live here, a session whose
   * title has not landed yet, and a host without the title service all answer
   * `""`, which is the protocol's "no title" value rather than a failure.
   * @param id - session to read.
   * @returns the title, or an empty string when there is none to read.
   */
  title(id: string): string {
    const now = this.#now()
    const cached = this.#titles.get(id)
    if (cached !== undefined && now - cached.at < this.#ttlMs) return cached.title
    const title = this.#resolve(id)
    this.#titles.delete(id)
    this.#titles.set(id, { title, at: now })
    this.#evict()
    return title
  }

  /**
   * The title already resolved for one id, without reading any service.
   *
   * `session.list` uses this to fill a row it can fill for free; a roster must
   * not put one title read on the path of every row it lists.
   * @param id - session to look up.
   * @returns the cached title while the cache window is open, else undefined.
   */
  cachedTitle(id: string): string | undefined {
    const cached = this.#titles.get(id)
    if (cached === undefined || this.#now() - cached.at >= this.#ttlMs) return undefined
    return cached.title
  }

  /**
   * The host's archive set, or undefined when it cannot be read.
   *
   * Reading it is the only way a row can carry `archived`: the key is omitted
   * rather than guessed when the workspace registry is not mounted, so a client
   * never reads "not archived" out of a bridge that simply could not tell.
   * @returns the archived session ids, or undefined when the registry is unavailable.
   */
  archiveSet(): ReadonlySet<string> | undefined {
    try {
      const ids = this.#faces().archive?.archivedSessionIds
      return ids === undefined ? undefined : new Set(ids)
    } catch (error) {
      this.#log(`the session archive set could not be read: ${failureText(error)}`)
      return undefined
    }
  }

  /** Resolve one title through the host services, degrading to `""` on any failure. */
  #resolve(id: string): string {
    try {
      const faces = this.#faces()
      const session = faces.sessions?.get(id)
      if (session === undefined) return ''
      return faces.titles?.get(session)?.title ?? ''
    } catch (error) {
      // One unreadable title must not fail the batch around it, and must not
      // reach the client as an error: the id has no title, which is a value.
      this.#log(`the title of session "${id}" could not be read: ${failureText(error)}`)
      return ''
    }
  }

  /** Drop the oldest ids until the cache is back inside its bound. */
  #evict(): void {
    while (this.#titles.size > TITLE_CACHE_LIMIT) {
      const oldest = this.#titles.keys().next()
      if (oldest.done === true) return
      this.#titles.delete(oldest.value)
    }
  }
}
