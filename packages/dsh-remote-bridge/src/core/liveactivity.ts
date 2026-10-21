/**
 * The Live Activity half of the push channel (protocol §29).
 *
 * The alert channel in `core/push.ts` tells a phone something happened; a Live
 * Activity is the lock-screen card that keeps being right while the app is
 * suspended, which is why it is a second payload with its own rules rather than
 * a field on the first one:
 *
 * - the request is a `liveactivity` push to a per-card APNs token, under the app
 *   bundle's `.push-type.liveactivity` topic, with `apns-expiration: 0` — a card
 *   update that arrives late is a lie about the present, so it is never resent;
 * - `content-state` is the App's own `SessionActivityState`, decoded with
 *   ActivityKit's default Codable strategy. Timestamps in it are seconds since
 *   Apple's reference date (2001-01-01T00:00:00Z), never Unix seconds: a Unix
 *   number decodes as a date decades away and the whole card fails to decode;
 * - one card shows one session. A registered card names its session, a card
 *   without one is never pushed to, and a state is delivered to the cards whose
 *   session it is about — never to "all cards", because that is how one session's
 *   question ends up on another session's lock screen (§29.9). `runningCount` is
 *   the one bridge-wide number on a card, and it stays the total on purpose;
 * - a card that would say what the card before it already said is not sent, one
 *   activity takes at most one update per `LIVE_ACTIVITY_INTERVAL_MS`, and
 *   the whole bridge at most `LIVE_ACTIVITY_PER_MINUTE` a minute. What does
 *   not fit is dropped, never queued: a card is a snapshot of now, and a backlog
 *   of stale snapshots is exactly what this channel must not deliver.
 *
 * Nothing here is awaited by a frame path. Every entry point returns before a
 * delivery starts, and a failure — connection, 401, 410, 5xx, timeout — is one
 * log line and a dropped card, never a delayed or broken follow stream (§28.5).
 * @module dsh-remote-bridge/core/liveactivity
 */

import type { PushSendResult } from './push.ts'
import { pushEventOfTurnEnd } from './push.ts'

/** The phases a lock-screen card can report. */
export type SessionActivityPhase = 'running' | 'waitingForAnswer' | 'failed' | 'ended'

/** The two events one Live Activity push carries. */
export type LiveActivityEvent = 'update' | 'end'

/**
 * Seconds from 1970-01-01T00:00:00Z to Apple's reference date, 2001-01-01T00:00:00Z.
 *
 * ActivityKit encodes a `Date` as a double relative to that reference date, so a
 * value meant to decode as "now" is Unix seconds minus this offset.
 */
export const APPLE_REFERENCE_OFFSET_SECONDS = 978_307_200

/** How long after delivery iOS may still treat a card as current. */
export const LIVE_ACTIVITY_STALE_SECONDS = 90

/** Shortest gap between two updates of the same activity. */
export const LIVE_ACTIVITY_INTERVAL_MS = 5_000

/** Most Live Activity pushes this bridge sends in any rolling minute. */
export const LIVE_ACTIVITY_PER_MINUTE = 30

/** Longest option list a card carries; the App shows them as the answer choices. */
export const LIVE_ACTIVITY_OPTION_LIMIT = 2

/** Activity ids whose last content is remembered before the oldest is forgotten. */
export const LIVE_ACTIVITY_TRACKED = 64

/**
 * The one line a card shows in each state.
 *
 * Fixed strings, for the reason the alert channel's bodies are fixed: a line
 * built out of host text is session content on a lock screen. These are the same
 * words the alert channel uses for the same events, so one turn the user saw as
 * a notification is the same turn the card names.
 */
export const ACTIVITY_STATUS_LINE = {
  running: '正在执行',
  question: '有待回答的问题',
  approval: '有待确认的审批',
  failed: '回合异常结束',
  ended: '回合结束',
} as const

/**
 * How iOS ranks one card against another.
 *
 * A card waiting on the user outranks one reporting work in progress, which in
 * turn outranks a finished one; `ended` is last because it is on its way out.
 */
const RELEVANCE_SCORE: Readonly<Record<SessionActivityPhase, number>> = {
  waitingForAnswer: 100,
  failed: 90,
  running: 60,
  ended: 10,
}

/**
 * One card's state, as the App's own `SessionActivityState` decodes it.
 *
 * The key set is frozen (§29): no field may be added or renamed, because the
 * App's Codable type is the other half of this contract and a key it does not
 * declare fails the whole decode.
 */
export interface SessionActivityState {
  readonly phase: SessionActivityPhase
  readonly statusLine: string
  readonly questionHeader?: string
  readonly optionLabels?: readonly string[]
  /** Apple-reference-date seconds of the moment this bridge delivered the card. */
  readonly asOf: number
  /** Sessions running right now across the whole bridge, never below 1. */
  readonly runningCount: number
}

/** The request body one Live Activity delivery carries (protocol §29). */
export interface LiveActivityNotification {
  readonly aps: {
    /** Unix epoch seconds of the delivery. */
    readonly timestamp: number
    readonly event: LiveActivityEvent
    readonly 'content-state': SessionActivityState
    /** Unix epoch seconds after which the card is stale: the delivery plus 90. */
    readonly 'stale-date': number
    readonly 'relevance-score': number
    /** Only an `end` for a card whose session left the roster dismisses at once. */
    readonly 'dismissal-date'?: number
  }
}

/** What the projection of one delivery says, before it is dated. */
export interface LiveActivityStateInput {
  readonly event: LiveActivityEvent
  readonly phase: SessionActivityPhase
  readonly statusLine: string
  readonly questionHeader?: string
  readonly optionLabels?: readonly string[]
  readonly runningCount: number
  /** Delivery moment, in milliseconds since the Unix epoch. */
  readonly now: number
  /** Dismiss the card the moment it is delivered, instead of letting it expire. */
  readonly dismiss?: boolean
}

/** @returns the score iOS ranks one card of this phase by. */
export function relevanceScoreOf(phase: SessionActivityPhase): number {
  return RELEVANCE_SCORE[phase]
}

/**
 * The content state one card carries.
 * @param input - the projection and the delivery moment.
 * @returns the frozen key set, in a fixed order.
 */
function contentStateOf(input: LiveActivityStateInput): SessionActivityState {
  const labels = input.optionLabels === undefined
    ? undefined
    : input.optionLabels.filter(label => label !== '').slice(0, LIVE_ACTIVITY_OPTION_LIMIT)
  return {
    phase: input.phase,
    statusLine: input.statusLine,
    ...(input.questionHeader === undefined || input.questionHeader === '' ? {} : { questionHeader: input.questionHeader }),
    ...(labels === undefined || labels.length === 0 ? {} : { optionLabels: labels }),
    // ActivityKit's default strategy decodes a `Date` as a double relative to
    // Apple's reference date, so this is not `now / 1000`.
    asOf: input.now / 1000 - APPLE_REFERENCE_OFFSET_SECONDS,
    runningCount: Math.max(1, Math.trunc(input.runningCount)),
  }
}

/**
 * The push one card gets.
 *
 * Pure, and exported so the shape can be asserted without a sender: the headers
 * and this key set are the contract, and every value derived from the delivery
 * moment is derived here, once.
 * @param input - the projection and the delivery moment.
 * @returns the exact body an APNs Live Activity delivery carries.
 */
export function buildLiveActivityNotification(input: LiveActivityStateInput): LiveActivityNotification {
  const timestamp = Math.floor(input.now / 1000)
  return {
    aps: {
      timestamp,
      event: input.event,
      'content-state': contentStateOf(input),
      'stale-date': timestamp + LIVE_ACTIVITY_STALE_SECONDS,
      'relevance-score': relevanceScoreOf(input.phase),
      ...(input.event === 'end' && input.dismiss === true ? { 'dismissal-date': timestamp } : {}),
    },
  }
}

/** One card this bridge may push to. */
export interface LiveActivityAddress {
  /** The activity the App created; stable for the life of one card. */
  readonly activityId: string
  /** The per-card APNs token, which is not the device's token. */
  readonly token: string
  /**
   * The session this card shows. Absent is a card this bridge never pushes to:
   * it has no state to put on it, and borrowing another session's state is
   * exactly what §29.9 forbids.
   */
  readonly sessionId?: string
  readonly environment: 'sandbox' | 'production'
  /** The app bundle id; the topic is this bundle plus the Live Activity suffix. */
  readonly bundle: string
}

/** Whatever actually reaches a card; the APNs client implements this. */
export interface LiveActivitySender {
  sendLiveActivity(target: LiveActivityAddress, notification: LiveActivityNotification): Promise<PushSendResult>
}

/** One row of a roster this bridge just served, as the projection reads it. */
export interface ActivityRosterRow {
  readonly id: string
  readonly agentRunning?: boolean
}

/** The question or approval one session's card is waiting on. */
interface Waiting {
  readonly statusLine: string
  readonly questionHeader?: string
  readonly optionLabels?: readonly string[]
}

export interface LiveActivityNotifierOptions {
  /** The cards that are alive right now, read per delivery. */
  readonly targets: () => readonly LiveActivityAddress[]
  /** The sender; absent is a bridge with no signing key, and then nothing happens. */
  readonly sender?: LiveActivitySender
  readonly now?: () => number
  readonly log?: (message: string) => void
  /**
   * Forget a token APNs reported dead. The roster owner removes it from the
   * device row and persists, so a token that can never work again is not retried
   * on every later card (§29 token lifecycle).
   */
  readonly retire?: (activityId: string, token: string) => Promise<boolean> | boolean | void
  readonly intervalMs?: number
  readonly perMinute?: number
}

/**
 * The bridge's Live Activity path.
 *
 * Deliberately inert when no sender is configured: `enabled` is false, no
 * card is ever read and no clock is consulted, so a bridge without an Apple key
 * behaves — byte for byte, frame for frame — exactly as it did before this
 * channel existed, and `push.register` still answers the same acknowledgement
 * (§28.3: registering is one thing, sending is another).
 */
export class LiveActivityNotifier {
  readonly #options: LiveActivityNotifierOptions
  readonly #now: () => number
  readonly #log: (message: string) => void
  /** Session ids the last roster reported as running. */
  #running = new Set<string>()
  /** Session ids the last roster named. */
  #listed = new Set<string>()
  /** Session ids any roster ever named, so "left the roster" is not "never listed". */
  #known = new Set<string>()
  /** The question or approval each session's card is waiting on, one entry per session. */
  readonly #waiting = new Map<string, Waiting>()
  /** Content last admitted per activity id. */
  readonly #content = new Map<string, string>()
  /** When each activity id was last updated, in milliseconds. */
  readonly #updated = new Map<string, number>()
  /** Delivery timestamps inside the rolling minute. */
  #recent: number[] = []
  /** Cards already reported as carrying no session, so the line is logged once each. */
  readonly #unaddressed = new Set<string>()

  constructor(options: LiveActivityNotifierOptions) {
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => undefined)
  }

  /** @returns whether this bridge will actually deliver anything. */
  get enabled(): boolean {
    return this.#options.sender !== undefined
  }

  /**
   * Take the roster this bridge just served as the current picture of what runs.
   *
   * A listing is the only place this bridge learns which sessions are live, so it
   * is where each running session's own card is refreshed: that session's card is
   * told it is running, and the number beside it is how many sessions are running
   * in total. A card waiting on the user keeps that state — listing sessions is
   * not an answer, and downgrading the card would hide the question still owed.
   * @param rows - the roster rows, as this connection built them.
   */
  noteRoster(rows: readonly ActivityRosterRow[]): void {
    if (!this.enabled) return
    try {
      this.#listed = new Set()
      this.#running = new Set()
      for (const row of rows) {
        this.#listed.add(row.id)
        this.#known.add(row.id)
        if (row.agentRunning === true) this.#running.add(row.id)
      }
      const runningCount = this.#running.size
      if (runningCount === 0) return
      for (const sessionId of this.#running) {
        if (this.#waiting.has(sessionId)) continue
        this.#emit(sessionId, {
          event: 'update',
          phase: 'running',
          statusLine: ACTIVITY_STATUS_LINE.running,
          runningCount,
        })
      }
    } catch (error) {
      this.#log(`live activity could not be prepared from a roster: ${String(error)}`)
    }
  }

  /**
   * Report one turn that ended.
   *
   * Only that session's own card is affected: the session stops running, its
   * pending question is gone with the turn, and its card is ended — not updated —
   * because the turn it was about is over. A session that was listed before and
   * is not in the roster any more has left it, so its card is dismissed on
   * delivery instead of being left on a lock screen to describe a session that no
   * longer exists.
   * @param sessionId - the session whose turn ended.
   * @param reason - the host's own reason, read exactly as the alert channel reads it.
   */
  noteTurnEnd(sessionId: string, reason: string): void {
    if (!this.enabled) return
    try {
      this.#waiting.delete(sessionId)
      this.#running.delete(sessionId)
      const completed = pushEventOfTurnEnd(reason) === 'turn-end'
      this.#emit(sessionId, {
        event: 'end',
        phase: completed ? 'ended' : 'failed',
        statusLine: completed ? ACTIVITY_STATUS_LINE.ended : ACTIVITY_STATUS_LINE.failed,
        runningCount: this.#running.size,
        ...(this.#known.has(sessionId) && !this.#listed.has(sessionId) ? { dismiss: true } : {}),
      })
    } catch (error) {
      this.#log(`live activity end for ${sessionId} could not be prepared: ${String(error)}`)
    }
  }

  /**
   * Report a question that reached a phone and is now waiting for an answer.
   *
   * Only the header and at most two option labels cross: they are the choices the
   * App can offer. The question itself and its detail stay behind the wire, the
   * same rule the alert channel follows (§28.4), and only this session's card is
   * told — another session's card has no business showing this question (§29.9).
   * @param sessionId - the session that asked.
   * @param question - the first question of the claimed batch.
   */
  noteQuestion(sessionId: string, question: { readonly header?: string; readonly optionLabels?: readonly string[] }): void {
    if (!this.enabled) return
    try {
      const header = question.header === '' ? undefined : question.header
      const labels = question.optionLabels?.filter(label => label !== '').slice(0, LIVE_ACTIVITY_OPTION_LIMIT)
      const waiting: Waiting = {
        statusLine: ACTIVITY_STATUS_LINE.question,
        ...(header === undefined ? {} : { questionHeader: header }),
        ...(labels === undefined || labels.length === 0 ? {} : { optionLabels: labels }),
      }
      this.#waiting.set(sessionId, waiting)
      this.#emit(sessionId, { event: 'update', phase: 'waitingForAnswer', runningCount: this.#running.size, ...waiting })
    } catch (error) {
      this.#log(`live activity question for ${sessionId} could not be prepared: ${String(error)}`)
    }
  }

  /**
   * Report an approval that reached a phone and is blocking the agent.
   *
   * The card says what state that session is in and nothing more: an approval's
   * own summary is a tool's reason text, which is exactly the session content a
   * lock screen must not carry, so it gets the fixed line and no details.
   * @param sessionId - the session whose tool is blocked.
   */
  noteApproval(sessionId: string): void {
    if (!this.enabled) return
    try {
      const waiting: Waiting = { statusLine: ACTIVITY_STATUS_LINE.approval }
      this.#waiting.set(sessionId, waiting)
      this.#emit(sessionId, { event: 'update', phase: 'waitingForAnswer', runningCount: this.#running.size, ...waiting })
    } catch (error) {
      this.#log(`live activity approval for ${sessionId} could not be prepared: ${String(error)}`)
    }
  }

  /**
   * Report that the question one card was waiting on is gone — answered here, on
   * the desktop, or expired.
   *
   * A card left saying "waiting for an answer" after the answer landed is the one
   * lie a lock screen cannot afford, so that session's card goes back to whatever
   * is true now. Nothing is sent when that session is not known to run: there is
   * no fact to show, and the ended card already covers that case.
   * @param sessionId - the session whose claim settled.
   */
  noteSettled(sessionId: string): void {
    if (!this.enabled) return
    if (!this.#waiting.has(sessionId)) return
    try {
      this.#waiting.delete(sessionId)
      if (!this.#running.has(sessionId)) return
      this.#emit(sessionId, {
        event: 'update',
        phase: 'running',
        statusLine: ACTIVITY_STATUS_LINE.running,
        runningCount: this.#running.size,
      })
    } catch (error) {
      this.#log(`live activity resume for ${sessionId} could not be prepared: ${String(error)}`)
    }
  }

  /**
   * The cards one session's state is delivered to.
   *
   * A card that names no session is skipped and reported once: §29.9 makes the
   * session the address, and a card this bridge cannot address is a card it must
   * not write to at all.
   * @param sessionId - the session the state is about.
   * @returns that session's cards, possibly none.
   */
  #targetsFor(sessionId: string): readonly LiveActivityAddress[] {
    const matched: LiveActivityAddress[] = []
    for (const target of this.#options.targets()) {
      if (target.sessionId === undefined) {
        if (this.#unaddressed.has(target.activityId)) continue
        this.#unaddressed.add(target.activityId)
        this.#log(`live activity ${target.activityId} names no session and is never pushed to`)
        while (this.#unaddressed.size > LIVE_ACTIVITY_TRACKED) {
          const oldest = this.#unaddressed.keys().next()
          if (oldest.done === true) break
          this.#unaddressed.delete(oldest.value)
        }
        continue
      }
      if (target.sessionId === sessionId) matched.push(target)
    }
    return matched
  }

  /** Build one session's delivery and start it, or drop it. */
  #emit(sessionId: string, state: {
    readonly event: LiveActivityEvent
    readonly phase: SessionActivityPhase
    readonly statusLine: string
    readonly questionHeader?: string
    readonly optionLabels?: readonly string[]
    readonly runningCount: number
    readonly dismiss?: boolean
  }): void {
    const sender = this.#options.sender
    if (sender === undefined) return
    const targets = this.#targetsFor(sessionId)
    if (targets.length === 0) return
    const now = this.#now()
    const notification = buildLiveActivityNotification({ ...state, now })
    const content = contentKeyOf(notification.aps['content-state'])
    for (const target of targets) {
      if (!this.#admits(target.activityId, content, state.event, now)) continue
      void Promise.resolve()
        .then(async () => await sender.sendLiveActivity(target, notification))
        .then((result) => { if (!result.ok) this.#failed(target, state.event, result) })
        .catch((error: unknown) => {
          this.#log(`live activity ${state.event} for ${target.activityId} failed: ${String(error)}`)
        })
    }
  }

  /**
   * @returns whether this activity may take this content now; records the send
   * when it may. Everything refused here is dropped, never queued.
   */
  #admits(activityId: string, content: string, event: LiveActivityEvent, now: number): boolean {
    if (this.#content.get(activityId) === content) return false
    if (event === 'update') {
      const interval = this.#options.intervalMs ?? LIVE_ACTIVITY_INTERVAL_MS
      const last = this.#updated.get(activityId)
      if (last !== undefined && now - last < interval) return false
    }
    this.#recent = this.#recent.filter(at => now - at < 60_000)
    if (this.#recent.length >= (this.#options.perMinute ?? LIVE_ACTIVITY_PER_MINUTE)) return false
    this.#recent.push(now)
    // Delete before set so the entry moves to the end: the map is trimmed from its
    // head, and an activity that is still in use must not be the one forgotten.
    this.#content.delete(activityId)
    this.#content.set(activityId, content)
    if (event === 'update') this.#updated.set(activityId, now)
    while (this.#content.size > LIVE_ACTIVITY_TRACKED) {
      const oldest = this.#content.keys().next()
      if (oldest.done === true) break
      this.#content.delete(oldest.value)
      this.#updated.delete(oldest.value)
    }
    return true
  }

  /** Log one failed delivery and, when the token is dead, forget it. */
  #failed(target: LiveActivityAddress, event: LiveActivityEvent, result: PushSendResult): void {
    const reason = result.reason ?? ''
    this.#log(`live activity ${event} for ${target.activityId} was not delivered (${result.status ?? '-'} ${reason === '' ? 'no reason' : reason})`)
    const dead = result.status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken'
    if (!dead) return
    const retire = this.#options.retire
    if (retire === undefined) return
    void Promise.resolve()
      .then(async () => await retire(target.activityId, target.token))
      .then((dropped) => {
        if (dropped === false) this.#log(`live activity token for ${target.activityId} was dead but matched no device row`)
      })
      .catch((error: unknown) => {
        this.#log(`live activity token for ${target.activityId} could not be dropped: ${String(error)}`)
      })
  }
}

/**
 * What identifies a content state for the dedupe.
 *
 * `asOf` is left out on purpose: it is the delivery moment, so it differs on
 * every build, and including it would make "the same content was sent" impossible
 * to observe — a card is a duplicate exactly when everything a user can read on
 * it is unchanged.
 * @param state - the content state of one delivery.
 * @returns a stable key for the readable part of it.
 */
export function contentKeyOf(state: SessionActivityState): string {
  return JSON.stringify([
    state.phase,
    state.statusLine,
    state.questionHeader ?? null,
    state.optionLabels ?? null,
    state.runningCount,
  ])
}
