import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceRoster, type PushRegistration } from '../src/core/devices.ts'
import {
  ACTIVITY_STATUS_LINE,
  APPLE_REFERENCE_OFFSET_SECONDS,
  LIVE_ACTIVITY_INTERVAL_MS,
  LIVE_ACTIVITY_PER_MINUTE,
  LiveActivityNotifier,
  buildLiveActivityNotification,
  type LiveActivityAddress,
  type LiveActivityNotification,
  type LiveActivitySender,
} from '../src/core/liveactivity.ts'
import { CAP_PUSH } from '../src/core/protocol.ts'
import type { PushSendResult } from '../src/core/push.ts'
import { liveActivityRequestSpec, liveActivityTopicOf } from '../src/host/apns.ts'
import { ControllableStream, answerOf, makeConnection, makeHub, requestFrame, settle } from './support/harness.ts'

/** One follow record as DSH writes it. */
function record(type: string, seq: number, time: number, data: unknown): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

/** The one card these suites push to. */
const CARD: LiveActivityAddress = { activityId: 'act-1', token: 'ff00aa', environment: 'sandbox', bundle: 'dev.dsh.Whale' }

/** A clock one millisecond short of the 2023 reference second these suites assume. */
const CLOCK_START = 1_700_000_000_000

/** A recording sender: what the notifier actually asked to deliver, in order. */
interface CardRecorder {
  readonly sent: { readonly target: LiveActivityAddress; readonly notification: LiveActivityNotification }[]
  readonly sender: LiveActivitySender
}

function recorder(): CardRecorder {
  const sent: { target: LiveActivityAddress; notification: LiveActivityNotification }[] = []
  return {
    sent,
    sender: {
      async sendLiveActivity(target, notification) {
        sent.push({ target, notification })
        return { ok: true, status: 200 }
      },
    },
  }
}

/** A notifier over one card list and a clock the suite owns. */
function notifierAt(
  sender: LiveActivitySender | undefined,
  clock: { now: number },
  extra: {
    readonly targets?: readonly LiveActivityAddress[]
    readonly logs?: string[]
    readonly retire?: (activityId: string, token: string) => Promise<boolean> | boolean | void
  } = {},
): LiveActivityNotifier {
  const logs = extra.logs
  return new LiveActivityNotifier({
    targets: () => extra.targets ?? [CARD],
    ...(sender === undefined ? {} : { sender }),
    now: () => clock.now,
    ...(logs === undefined ? {} : { log: (message: string): void => { logs.push(message) } }),
    ...(extra.retire === undefined ? {} : { retire: extra.retire }),
  })
}

/** One roster row in the shape every probe entry of a real table has. */
function rosterRow(deviceId = 'dev_probe0'): Record<string, unknown> {
  return {
    deviceId,
    pubKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE0',
    fingerprint: 'fingerprint-0',
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    tokenHash: 'hash-0',
  }
}

/** A registration as a phone with one live card would send it. */
function registrationOf(tokens: readonly { activityId: string; token: string }[]): PushRegistration {
  return { deviceToken: 'aabbccdd', environment: 'sandbox', bundle: 'dev.dsh.Whale', liveActivityTokens: tokens, registeredAt: 1_700_000_000_000 }
}

async function rosterFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-bridge-card-'))
  return join(directory, 'remote-bridge', 'devices.json')
}

/** Write one roster file, creating the directory it lives in. */
async function writeRoster(file: string, body: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(body), 'utf8')
}

describe('live activity: the request APNs receives', () => {
  it('operator reads the card request and every header is the frozen one', () => {
    // Given one sandbox card and its provider token
    // When the delivery request is built
    const sandbox = liveActivityRequestSpec(CARD, 'jwt')
    const production = liveActivityRequestSpec({ ...CARD, environment: 'production' }, 'jwt')
    // Then the token of the card is the path, not the device's token
    expect(sandbox.path).toBe('/3/device/ff00aa')
    expect(production.authority).toBe('api.push.apple.com')
    expect(sandbox.authority).toBe('api.sandbox.push.apple.com')
    // And the four frozen headers are exactly what a Live Activity requires
    expect(sandbox.headers['apns-push-type']).toBe('liveactivity')
    expect(sandbox.headers['apns-topic']).toBe('dev.dsh.Whale.push-type.liveactivity')
    expect(sandbox.headers['apns-priority']).toBe('10')
    expect(sandbox.headers['apns-expiration']).toBe('0')
    expect(sandbox.headers.authorization).toBe('bearer jwt')
    // And the topic suffix is appended once, never twice
    expect(liveActivityTopicOf('dev.dsh.Whale')).toBe('dev.dsh.Whale.push-type.liveactivity')
    expect(liveActivityTopicOf('dev.dsh.Whale.push-type.liveactivity')).toBe('dev.dsh.Whale.push-type.liveactivity')
  })

  it('operator builds a running card and the body holds exactly the frozen key set', () => {
    // Given the delivery moment a card is built for
    // When one running card is built
    const notification = buildLiveActivityNotification({
      event: 'update',
      phase: 'running',
      statusLine: ACTIVITY_STATUS_LINE.running,
      runningCount: 2,
      now: CLOCK_START,
    })
    // Then the body is one aps block and nothing else
    expect(Object.keys(notification)).toEqual(['aps'])
    expect(Object.keys(notification.aps).sort()).toEqual(['content-state', 'event', 'relevance-score', 'stale-date', 'timestamp'])
    // And the content state is the four keys a running card carries
    expect(Object.keys(notification.aps['content-state'])).toEqual(['phase', 'statusLine', 'asOf', 'runningCount'])
    // And every derived number is the one the contract names
    expect(notification.aps.timestamp).toBe(1_700_000_000)
    expect(notification.aps['stale-date']).toBe(1_700_000_090)
    expect(notification.aps['relevance-score']).toBe(60)
    expect(notification.aps['content-state'].runningCount).toBe(2)
    // And asOf is seconds since Apple's reference date, never Unix seconds: the
    // difference is the whole reason ActivityKit can decode the card at all
    expect(notification.aps['content-state'].asOf).toBe(1_700_000_000 - APPLE_REFERENCE_OFFSET_SECONDS)
    expect(notification.aps['content-state'].asOf).toBe(721_692_800)
    expect(notification.aps['content-state'].asOf).not.toBe(notification.aps.timestamp)
  })

  it('operator reads the four relevance scores and the one-label-less state', () => {
    // Given one delivery moment and the four phases a card can report
    const phases = ['waitingForAnswer', 'failed', 'running', 'ended'] as const
    // When each is built
    const scores = phases.map(phase => buildLiveActivityNotification({
      event: phase === 'ended' || phase === 'failed' ? 'end' : 'update',
      phase,
      statusLine: ACTIVITY_STATUS_LINE.running,
      runningCount: 1,
      now: CLOCK_START,
    }).aps['relevance-score'])
    // Then the score is the frozen one per phase
    expect(scores).toEqual([100, 90, 60, 10])
    // And a card with no question carries neither question key
    expect(Object.keys(buildLiveActivityNotification({
      event: 'update',
      phase: 'waitingForAnswer',
      statusLine: ACTIVITY_STATUS_LINE.approval,
      runningCount: 1,
      now: CLOCK_START,
    }).aps['content-state'])).toEqual(['phase', 'statusLine', 'asOf', 'runningCount'])
  })

  it('operator sees the question keys and the two-label limit the card carries', () => {
    // Given a question with a header and three options
    // When its card is built
    const notification = buildLiveActivityNotification({
      event: 'update',
      phase: 'waitingForAnswer',
      statusLine: ACTIVITY_STATUS_LINE.question,
      questionHeader: 'Deck',
      optionLabels: ['Alpha', 'Bravo', 'Charlie'],
      runningCount: 1,
      now: CLOCK_START,
    })
    // Then the key order is the frozen one and the score is the highest there is
    expect(Object.keys(notification.aps['content-state'])).toEqual(['phase', 'statusLine', 'questionHeader', 'optionLabels', 'asOf', 'runningCount'])
    expect(notification.aps['relevance-score']).toBe(100)
    // And only the two labels the lock screen can show as buttons remain
    expect(notification.aps['content-state'].optionLabels).toEqual(['Alpha', 'Bravo'])
    expect(notification.aps['content-state'].questionHeader).toBe('Deck')
  })

  it('operator ends a card and only a dismissed one carries a dismissal date', () => {
    // Given one ended card and the same card dismissed on delivery
    // When both bodies are built
    const ended = { event: 'end', phase: 'ended', statusLine: ACTIVITY_STATUS_LINE.ended, runningCount: 1, now: CLOCK_START } as const
    const normal = buildLiveActivityNotification(ended)
    const dismissed = buildLiveActivityNotification({ ...ended, dismiss: true })
    // Then a normal end is the five keys, with no dismissal date to hurry it away
    expect(Object.keys(normal.aps)).toEqual(['timestamp', 'event', 'content-state', 'stale-date', 'relevance-score'])
    expect(normal.aps['content-state'].phase).toBe('ended')
    expect(normal.aps['relevance-score']).toBe(10)
    // And a dismissed one names the delivery second as the moment it goes
    expect(dismissed.aps['dismissal-date']).toBe(dismissed.aps.timestamp)
    expect(dismissed.aps['dismissal-date']).toBe(1_700_000_000)
    // And asking to dismiss an update changes nothing: only an end can dismiss
    expect(buildLiveActivityNotification({ ...ended, event: 'update', phase: 'running', dismiss: true }).aps).not.toHaveProperty('dismissal-date')
  })
})

describe('live activity: what the bridge sends, and what it drops', () => {
  it('operator sees the same card content once, however often the roster repeats it', async () => {
    // Given a bridge with one card and one running session
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    await settle()
    // Then one card went out
    expect(sink.sent).toHaveLength(1)
    // When a later listing says exactly the same thing
    clock.now += 10 * LIVE_ACTIVITY_INTERVAL_MS
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    await settle()
    // Then nothing new is sent: the card already says it
    expect(sink.sent).toHaveLength(1)
    expect(sink.sent[0]?.notification.aps['content-state']).toMatchObject({ phase: 'running', runningCount: 1 })
  })

  it('operator gets one update per five seconds and the dropped one is never replayed', async () => {
    // Given a bridge that just updated its card
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    await settle()
    expect(sink.sent).toHaveLength(1)
    // When a question arrives one second later
    clock.now += 1_000
    notifier.noteQuestion('s-2', { header: 'Deck' })
    await settle()
    // Then the card is not updated yet, and the drop is not queued for later
    expect(sink.sent).toHaveLength(1)
    // When the five seconds have passed and the same question is still open
    clock.now += LIVE_ACTIVITY_INTERVAL_MS
    notifier.noteQuestion('s-2', { header: 'Deck' })
    await settle()
    // Then exactly that one update goes out, and only once
    expect(sink.sent).toHaveLength(2)
    expect(sink.sent.map(entry => entry.notification.aps['content-state'].phase)).toEqual(['running', 'waitingForAnswer'])
    await settle()
    expect(sink.sent).toHaveLength(2)
  })

  it('operator sees the whole bridge capped at thirty cards a minute', async () => {
    // Given thirty-five live cards
    const clock = { now: CLOCK_START }
    const cards = Array.from({ length: LIVE_ACTIVITY_PER_MINUTE + 5 }, (_, index) => {
      return { ...CARD, activityId: 'act-' + String(index), token: 'ff' + String(index) }
    })
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock, { targets: cards })
    // When one running state is announced
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    await settle()
    // Then the cap is what went out and the rest was dropped
    expect(sink.sent).toHaveLength(LIVE_ACTIVITY_PER_MINUTE)
    expect(sink.sent.map(entry => entry.target.activityId)).toEqual(cards.slice(0, LIVE_ACTIVITY_PER_MINUTE).map(card => card.activityId))
  })

  it('operator runs a bridge with no signing key and the card path never wakes', async () => {
    // Given a bridge with no sender at all — the default deployment
    const clock = { now: CLOCK_START }
    const logs: string[] = []
    let targetReads = 0
    let clockReads = 0
    const notifier = new LiveActivityNotifier({
      targets: () => { targetReads += 1; return [CARD] },
      now: () => { clockReads += 1; return clock.now },
      log: (message: string): void => { logs.push(message) },
    })
    // Then it reports itself disabled
    expect(notifier.enabled).toBe(false)
    // When every entry point is driven anyway
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    notifier.noteQuestion('s-1', { header: 'Deck' })
    notifier.noteApproval('s-1')
    notifier.noteTurnEnd('s-1', 'completed')
    notifier.noteSettled('s-1')
    await settle()
    // Then nothing was read, nothing was sent and not one line was logged
    expect(targetReads).toBe(0)
    expect(clockReads).toBe(0)
    expect(logs).toEqual([])
  })

  it('user registers a card token and the answer does not wait for any sender', async () => {
    // Given a paired phone on a bridge whose card path is off
    const file = await rosterFile()
    await writeRoster(file, { version: 2, devices: [rosterRow('dev_harness')] })
    const roster = new DeviceRoster({ file })
    await roster.load()
    const harness = makeConnection({ paired: true, roster, liveActivity: notifierAt(undefined, { now: CLOCK_START }) })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [CAP_PUSH] }))
    // When it registers the token of the card it just created
    await harness.connection.handleText(requestFrame(2, 'push.register', {
      deviceToken: 'aabbccdd',
      environment: 'sandbox',
      bundle: 'dev.dsh.Whale',
      liveActivityTokens: [{ activityId: 'act-1', token: 'ff00' }],
    }))
    // Then the answer is the same empty acknowledgement as before this channel
    expect(answerOf(harness, 2)).toEqual({ ok: true, r: { ok: true } })
    // And the token is on the row, ready for a later card
    expect(roster.pushTargets()[0]?.push.liveActivityTokens).toEqual([{ activityId: 'act-1', token: 'ff00' }])
  })
})

describe('live activity: a token APNs reports dead', () => {
  it('operator loses the dead card tokens and keeps the live one, with no retry', async () => {
    // Given a roster row holding three cards
    const file = await rosterFile()
    await writeRoster(file, {
      version: 2,
      devices: [{
        ...rosterRow(),
        push: registrationOf([
          { activityId: 'act-gone', token: 'ff00' },
          { activityId: 'act-bad', token: 'ff01' },
          { activityId: 'act-live', token: 'ff02' },
        ]),
      }],
    })
    const roster = new DeviceRoster({ file })
    await roster.load()
    const clock = { now: CLOCK_START }
    const attempted: string[] = []
    let retirement: Promise<boolean> = Promise.resolve(false)
    const sender: LiveActivitySender = {
      async sendLiveActivity(target): Promise<PushSendResult> {
        attempted.push(target.activityId)
        if (target.activityId === 'act-gone') return { ok: false, status: 410, reason: 'Unregistered' }
        if (target.activityId === 'act-bad') return { ok: false, status: 400, reason: 'BadDeviceToken' }
        return { ok: true, status: 200 }
      },
    }
    const notifier = new LiveActivityNotifier({
      targets: () => roster.pushTargets().flatMap(({ push }) => (push.liveActivityTokens ?? []).map(({ activityId, token }) => ({
        activityId,
        token,
        environment: push.environment,
        bundle: push.bundle,
      }))),
      sender,
      now: () => clock.now,
      retire: (activityId, token) => {
        retirement = roster.removeLiveActivityToken(activityId, token)
        return retirement
      },
    })
    // When one running state is announced
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    await settle()
    await retirement
    // Then both dead tokens were attempted exactly once and dropped from the file
    expect(attempted).toEqual(['act-gone', 'act-bad', 'act-live'])
    const written = JSON.parse(await readFile(file, 'utf8')) as { devices: { push?: { liveActivityTokens?: unknown[] } }[] }
    expect(written.devices[0]?.push?.liveActivityTokens).toEqual([{ activityId: 'act-live', token: 'ff02' }])
    // And the next card is addressed to the one card that still exists, so the
    // refused tokens are never tried again
    clock.now += LIVE_ACTIVITY_INTERVAL_MS
    attempted.length = 0
    notifier.noteTurnEnd('s-1', 'completed')
    await settle()
    expect(attempted).toEqual(['act-live'])
    expect(roster.pushTargets()[0]?.push.liveActivityTokens).toEqual([{ activityId: 'act-live', token: 'ff02' }])
  })

  it('operator drops a card token whose device row no longer holds it, and says so', async () => {
    // Given a sender that always answers 410 and a roster that holds no such token
    const clock = { now: CLOCK_START }
    const logs: string[] = []
    let retirement: Promise<boolean> = Promise.resolve(true)
    const notifier = notifierAt(
      { async sendLiveActivity(): Promise<PushSendResult> { return { ok: false, status: 410, reason: 'Unregistered' } } },
      clock,
      { logs, retire: () => { retirement = Promise.resolve(false); return retirement } },
    )
    // When one running state is announced
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    await settle()
    await retirement
    // Then the failure is one line, the retirement reported no row, and nothing threw
    expect(logs.some(line => line.includes('was not delivered (410 Unregistered)'))).toBe(true)
    expect(logs.some(line => line.includes('matched no device row'))).toBe(true)
    expect(notifier.enabled).toBe(true)
  })
})

describe('live activity: the state the bridge projects', () => {
  it('user sees the card end with the turn it follows', async () => {
    // Given a paired connection whose bridge can reach two live cards
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    const harness = makeConnection({ paired: true, liveActivity: notifier })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [CAP_PUSH] }))
    const stream = new ControllableStream()
    harness.gateway.follow = call => stream.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(90, 'session.snapshot', { sessionId: 's-1' }))
    stream.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When that turn ends normally
    stream.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    // Then the card is ended, and says so in the one line the alert channel uses
    expect(sink.sent).toHaveLength(1)
    expect(sink.sent[0]?.notification.aps.event).toBe('end')
    expect(sink.sent[0]?.notification.aps['content-state']).toMatchObject({
      phase: 'ended',
      statusLine: '回合结束',
      runningCount: 1,
    })
    // And it is not dismissed: this bridge never listed that session, so it cannot
    // claim the session left a roster it was never in
    expect(sink.sent[0]?.notification.aps).not.toHaveProperty('dismissal-date')
  })

  it('user sees a failed turn on the card without the reason text', async () => {
    // Given a bridge able to reach a card
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    const harness = makeConnection({ paired: true, liveActivity: notifier })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [CAP_PUSH] }))
    const stream = new ControllableStream()
    harness.gateway.follow = call => stream.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(90, 'session.snapshot', { sessionId: 's-1' }))
    stream.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When the turn ends abnormally
    stream.push(record('turn/end', 20, 301, { turn: 2, reason: { kind: 'error', message: 'the tool exploded' } }))
    await settle()
    // Then the phase is failed, at the failed score, and the reason never crosses
    expect(sink.sent).toHaveLength(1)
    expect(sink.sent[0]?.notification.aps.event).toBe('end')
    expect(sink.sent[0]?.notification.aps['content-state'].phase).toBe('failed')
    expect(sink.sent[0]?.notification.aps['relevance-score']).toBe(90)
    expect(JSON.stringify(sink.sent[0]?.notification)).not.toContain('the tool exploded')
  })

  it('user lists sessions and the card reports how many are running', async () => {
    // Given a bridge able to reach a card
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    const harness = makeConnection({ paired: true, liveActivity: notifier })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1 }))
    harness.gateway.handler = async () => ({
      items: [
        { sessionId: 's-1', running: true, updatedAt: 2, blank: false },
        { sessionId: 's-2', running: true, updatedAt: 1, blank: false },
        { sessionId: 's-3', running: false, updatedAt: 0, blank: false },
      ],
    })
    // When it lists them
    await harness.connection.handleText(requestFrame(2, 'session.list'))
    await settle()
    // Then the card reports the two that are running
    expect(sink.sent).toHaveLength(1)
    expect(sink.sent[0]?.notification.aps['content-state']).toMatchObject({
      phase: 'running',
      statusLine: '正在执行',
      runningCount: 2,
    })
    // And a listing of nothing running raises no card at all
    harness.gateway.handler = async () => ({ items: [{ sessionId: 's-3', running: false, updatedAt: 0, blank: false }] })
    clock.now += LIVE_ACTIVITY_INTERVAL_MS
    await harness.connection.handleText(requestFrame(3, 'session.list'))
    await settle()
    expect(sink.sent).toHaveLength(1)
  })

  it('user is handed a question and the card asks for the answer with its buttons', async () => {
    // Given a hub whose bridge can reach a card, with one phone declaring questions
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    const harness = makeHub({ liveActivity: notifier })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['questions.v1'] }))
    // When the host asks something with three options
    void harness.hub.question({
      agent: { id: 's-1' },
      questions: [{
        id: 'q-1',
        question: 'Which deck should ship?',
        header: 'Deck',
        detail: 'Pick exactly one.',
        options: [{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }],
        multiSelect: false,
      }],
    }, async () => ({ answers: [] }))
    await settle()
    // Then the card is waiting for an answer, with the header and two buttons
    expect(sink.sent).toHaveLength(1)
    expect(sink.sent[0]?.notification.aps.event).toBe('update')
    expect(sink.sent[0]?.notification.aps['content-state']).toMatchObject({
      phase: 'waitingForAnswer',
      statusLine: '有待回答的问题',
      questionHeader: 'Deck',
      optionLabels: ['Alpha', 'Bravo'],
    })
    // And not one word of the question itself crossed
    const wire = JSON.stringify(sink.sent[0]?.notification)
    expect(wire).not.toContain('Which deck should ship?')
    expect(wire).not.toContain('Pick exactly one.')
  })

  it('user sees an approval blocking the agent and the tool reason stays home', async () => {
    // Given a hub whose bridge can reach a card, with one phone declaring approvals
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    const harness = makeHub({ liveActivity: notifier })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['approvals.v1'] }))
    // When a tool asks for an approval whose reason must not leave this machine
    void harness.hub.approve({
      agent: { id: 's-1' },
      toolName: 'bash',
      displayReason: { en: 'Remove the build directory', zh: '删除构建目录' },
    }, async () => 'rejected')
    await settle()
    // Then the card waits for the answer with the fixed approval line
    expect(sink.sent).toHaveLength(1)
    expect(sink.sent[0]?.notification.aps['content-state']).toMatchObject({ phase: 'waitingForAnswer', statusLine: '有待确认的审批' })
    // And it carries no question keys at all, and no reason text
    expect(Object.keys(sink.sent[0]?.notification.aps['content-state'] ?? {})).toEqual(['phase', 'statusLine', 'asOf', 'runningCount'])
    const wire = JSON.stringify(sink.sent[0]?.notification)
    expect(wire).not.toContain('bash')
    expect(wire).not.toContain('删除构建目录')
    expect(wire).not.toContain('Remove the build directory')
  })

  it('operator sees a card dismissed when the session it described left the roster', async () => {
    // Given a bridge that listed one running session
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    await settle()
    expect(sink.sent).toHaveLength(1)
    // When a later listing no longer names it, and its turn ends
    clock.now += 5 * LIVE_ACTIVITY_INTERVAL_MS
    notifier.noteRoster([{ id: 's-9', agentRunning: false }])
    notifier.noteTurnEnd('s-1', 'completed')
    await settle()
    // Then the end is dismissed on delivery instead of lingering on the lock screen
    expect(sink.sent).toHaveLength(2)
    expect(sink.sent[1]?.notification.aps.event).toBe('end')
    expect(sink.sent[1]?.notification.aps['dismissal-date']).toBe(sink.sent[1]?.notification.aps.timestamp)
  })

  it('operator sees the card leave the waiting state once the question is settled', async () => {
    // Given a card waiting on a question, with one session still running
    const clock = { now: CLOCK_START }
    const sink = recorder()
    const notifier = notifierAt(sink.sender, clock)
    notifier.noteRoster([{ id: 's-1', agentRunning: true }])
    await settle()
    clock.now += LIVE_ACTIVITY_INTERVAL_MS
    notifier.noteQuestion('s-1', { header: 'Deck' })
    await settle()
    expect(sink.sent).toHaveLength(2)
    expect(sink.sent[1]?.notification.aps['content-state'].phase).toBe('waitingForAnswer')
    // When the desktop answers it
    clock.now += LIVE_ACTIVITY_INTERVAL_MS
    notifier.noteSettled('s-1')
    await settle()
    // Then the card is back to what is true now
    expect(sink.sent).toHaveLength(3)
    expect(sink.sent[2]?.notification.aps['content-state']).toMatchObject({ phase: 'running', runningCount: 1 })
  })

  it('operator gets the card without any frame waiting for a delivery', async () => {
    // Given a sender that never answers
    const clock = { now: CLOCK_START }
    let release: (result: PushSendResult) => void = () => undefined
    const delivery = new Promise<PushSendResult>((resolve) => { release = resolve })
    const attempted: string[] = []
    const sender: LiveActivitySender = {
      async sendLiveActivity(target): Promise<PushSendResult> {
        attempted.push(target.activityId)
        return await delivery
      },
    }
    const notifier = notifierAt(sender, clock)
    // When a turn ends on the frame path
    notifier.noteTurnEnd('s-1', 'completed')
    // Then the call returned before anything was even attempted
    expect(attempted).toEqual([])
    // And the delivery started on its own, without the caller awaiting it
    await settle()
    expect(attempted).toEqual(['act-1'])
    release({ ok: true, status: 200 })
    await settle()
  })
})
