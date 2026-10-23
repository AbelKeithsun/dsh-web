import { describe, expect, it } from 'vitest'
import { CAP_USAGE, MINOR, SERVED_CAPABILITIES } from '../src/core/protocol.ts'
import { BALANCE_CACHE_TTL_MS, UsageService, type UsageFaces, type FetchFace } from '../src/core/usage.ts'
import { answerOf, makeConnection, requestFrame, type ConnectionHarness } from './support/harness.ts'

/** 一套宿主服务：活会话名单 + 宿主名册 + 凭据 + 设置，缺的就不给。 */
interface HostServices {
  readonly live?: readonly string[]
  /** 宿主名册里的会话 id；省略就是这台宿主给不出名册。 */
  readonly roster?: readonly string[]
  readonly credentials?: UsageFaces['credentials']
  readonly settings?: UsageFaces['settings']
}

/** 一份用量服务，时钟与上游都由套件自己拿着。 */
function usageOver(services: HostServices, clock: { now: number }, fetch: FetchFace, log: (message: string) => void = () => {}): UsageService {
  const live = services.live ?? []
  return new UsageService({
    faces: () => ({
      ...(services.live === undefined ? {} : { sessions: { get: id => (live.includes(id) ? { id } : undefined) } }),
      ...(services.roster === undefined ? {} : { roster: { ids: async () => services.roster } }),
      ...(services.credentials === undefined ? {} : { credentials: services.credentials }),
      ...(services.settings === undefined ? {} : { settings: services.settings }),
    }),
    now: () => clock.now,
    log,
    fetch,
  })
}

/** 一个记录上游调用的 fetch 替身：脚本说答什么，它答什么。 */
function upstreamOf(answer: { readonly status: number; readonly body: unknown } | 'timeout'): { readonly fetch: FetchFace; readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url, _init) => {
      calls.push(url)
      if (answer === 'timeout') throw new Error('The operation was aborted due to timeout')
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body,
      }
    },
  }
}

/** 一条官方 `/user/balance` 的应答体：金额按字符串给，元口径。 */
const OFFICIAL_BALANCE = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
}

/** 官方路由那一档的凭据：环境变量引用解析出一把 API key。 */
const OFFICIAL_CREDENTIALS = {
  readRecord: async () => undefined,
  resolve: async (ref: string) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-official' } : undefined),
}

/** 官方适配器的设置段：没配 `apiKeyEnv` 时读 `DEEPSEEK_API_KEY`。 */
const OFFICIAL_SETTINGS = {
  get: (ns: string): unknown => (ns === 'llm-deepseek' ? { apiKeyEnv: 'DEEPSEEK_API_KEY' } : undefined),
}

/** 一次握手：宣告给定的能力。 */
async function greet(harness: ConnectionHarness, cap: readonly string[]): Promise<void> {
  await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [...cap] }))
}

describe('usage channel over protocol v1', () => {
  it('user greeting the bridge is told the usage channel is served here with the minor that carries it', async () => {
    // Given a bridge that serves the usage channel
    const harness = makeConnection({ paired: true })
    // When the user greets it
    await greet(harness, [CAP_USAGE])
    // Then the announcement names the capability beside every other served one,
    // and the minor is the one that carries the two new reply bodies
    const hello = answerOf(harness, 1).r as { minor: number; capabilities: string[] }
    expect(hello.capabilities).toEqual([...SERVED_CAPABILITIES])
    expect(hello.capabilities).toContain(CAP_USAGE)
    expect(hello.minor).toBe(MINOR)
    expect(MINOR).toBe(19)
  })

  it('user that declared no capability is told neither usage method exists and every other method still answers', async () => {
    // Given a paired client written before the usage channel existed
    const harness = makeConnection({ paired: true })
    harness.gateway.handler = async () => ({ items: [] })
    await greet(harness, [])
    // When it calls one usage method and one method it always had
    await harness.connection.handleText(requestFrame(2, 'usage.session', { sessionId: 's-1' }))
    await harness.connection.handleText(requestFrame(3, 'usage.balance', { provider: 'deepseek-official' }))
    await harness.connection.handleText(requestFrame(4, 'session.list'))
    // Then both usage methods are unknown to it, and the roster is untouched
    expect(answerOf(harness, 2).e).toEqual({ code: 'unknown-method', msg: 'unknown method usage.session' })
    expect(answerOf(harness, 3).e).toEqual({ code: 'unknown-method', msg: 'unknown method usage.balance' })
    expect(answerOf(harness, 4).r).toEqual({ mode: 'reset', token: '', sessions: [] })
  })

  it('user reading a session that broadcast its window and its request reads both the host value and the estimate', async () => {
    // Given a live session whose host broadcast a window, a header with one tool,
    // a system prompt and two messages
    const clock = { now: 1_700_000_000_000 }
    const usage = usageOver({ live: ['s-1'] }, clock, upstreamOf({ status: 200, body: OFFICIAL_BALANCE }).fetch)
    usage.record('s-1', { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-chat', contextWindow: 131072 } })
    usage.record('s-1', { type: 'request/header', data: { header: { tools: [{ name: 'bash' }] } } })
    usage.record('s-1', { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'You are the bridge.' }] } } })
    usage.record('s-1', { type: 'user/message', data: { content: [{ type: 'text', text: 'ping' }] } })
    usage.record('s-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'pong' }] } } })
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user asks what that session's next request is made of
    await harness.connection.handleText(requestFrame(2, 'usage.session', { sessionId: 's-1' }))
    // Then the window is the host's own reading and every component is the UTF-8
    // byte length divided by four, each one floored and marked as an estimate
    expect(answerOf(harness, 2).r).toEqual({
      contextWindow: 131072,
      composition: { system: 4, tools: 4, messages: 2, estimated: true },
    })
  })

  it('user reading a session the host never broadcast a window for reads the composition alone', async () => {
    // Given a session whose only broadcast events are a tool-less header and a message
    const clock = { now: 1_700_000_000_000 }
    const usage = usageOver({ live: ['s-1'] }, clock, upstreamOf({ status: 200, body: OFFICIAL_BALANCE }).fetch)
    usage.record('s-1', { type: 'request/header', data: { header: {} } })
    usage.record('s-1', { type: 'user/message', data: { content: [{ type: 'text', text: 'ping' }] } })
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user asks about it
    await harness.connection.handleText(requestFrame(2, 'usage.session', { sessionId: 's-1' }))
    // Then there is no window key at all, and the tool-less header is a real zero
    // for its own component rather than a missing one
    expect(answerOf(harness, 2).r).toEqual({
      composition: { system: 0, tools: 0, messages: 1, estimated: true },
    })
  })

  it('user reading a live session that broadcast nothing is answered an empty object rather than zeros', async () => {
    // Given a live session nothing was ever observed for
    const clock = { now: 1_700_000_000_000 }
    const usage = usageOver({ live: ['s-1'] }, clock, upstreamOf({ status: 200, body: OFFICIAL_BALANCE }).fetch)
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user asks about it
    await harness.connection.handleText(requestFrame(2, 'usage.session', { sessionId: 's-1' }))
    // Then the answer says "nothing is known", not "nothing is there"
    expect(answerOf(harness, 2).r).toEqual({})
  })

  it('user reading a session the host roster names but this process never observed is answered an empty object', async () => {
    // Given a session the host's own roster knows while it is neither live nor observed
    const clock = { now: 1_700_000_000_000 }
    const usage = usageOver({ live: ['s-1'], roster: ['s-1', 's-cold'] }, clock, upstreamOf({ status: 200, body: OFFICIAL_BALANCE }).fetch)
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user reads it after the bridge was reloaded
    await harness.connection.handleText(requestFrame(2, 'usage.session', { sessionId: 's-cold' }))
    // Then it is a session this host has with no reading yet, not a session this
    // host never had, and nothing was invented for the two missing readings
    expect(answerOf(harness, 2)).toEqual({ ok: true, r: {} })
    expect(Object.keys(answerOf(harness, 2).r as Record<string, unknown>)).toEqual([])
  })

  it('user reading a session this host never had is refused as an unknown session', async () => {
    // Given a bridge whose roster, live store and event fold all know no such session
    const clock = { now: 1_700_000_000_000 }
    const usage = usageOver({ live: ['s-1'], roster: ['s-1'] }, clock, upstreamOf({ status: 200, body: OFFICIAL_BALANCE }).fetch)
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user asks about a session id nothing ever named
    await harness.connection.handleText(requestFrame(2, 'usage.session', { sessionId: 's-404' }))
    // Then the bridge says the session does not exist instead of answering {} or
    // a composition of zeros
    expect(answerOf(harness, 2)).toEqual({ ok: false, e: { code: 'unknown-session', msg: 'session s-404 does not exist on this host' } })
  })

  it('user reading the balance of the official route is answered the four amounts in yuan', async () => {
    // Given a deepseek route with no baseURL of its own and a resolvable API key
    const clock = { now: 1_700_000_000_000 }
    const upstream = upstreamOf({ status: 200, body: OFFICIAL_BALANCE })
    const usage = usageOver({ credentials: OFFICIAL_CREDENTIALS, settings: OFFICIAL_SETTINGS }, clock, upstream.fetch)
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user asks for that route's balance
    await harness.connection.handleText(requestFrame(2, 'usage.balance', { provider: 'deepseek-official' }))
    // Then the money crosses as numbers in the currency the endpoint reported,
    // stamped with this host's clock, and one upstream call was made
    expect(answerOf(harness, 2).r).toEqual({
      provider: 'deepseek-official',
      currency: 'CNY',
      total: 110,
      toppedUp: 100,
      granted: 10,
      updatedAt: clock.now,
    })
    expect(upstream.calls).toEqual(['https://api.deepseek.com/user/balance'])
  })

  it('user reading the balance of a route pointed at another origin is told it is no deepseek route', async () => {
    // Given a profile that reuses the deepseek id for a reseller endpoint
    const clock = { now: 1_700_000_000_000 }
    const upstream = upstreamOf({ status: 200, body: OFFICIAL_BALANCE })
    const usage = usageOver({
      credentials: OFFICIAL_CREDENTIALS,
      settings: { get: (ns: string): unknown => (ns === 'llm-pi-ai' ? { providers: { 'deepseek-official': { baseURL: 'https://dashscope.aliyuncs.com/v1' } } } : undefined) },
    }, clock, upstream.fetch)
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user asks for that route's balance
    await harness.connection.handleText(requestFrame(2, 'usage.balance', { provider: 'deepseek-official' }))
    // Then the bridge refuses to print the official account's money under it, and
    // no upstream call was made at all
    expect(answerOf(harness, 2).r).toEqual({ provider: 'deepseek-official', unsupported: 'not-deepseek-route' })
    expect(upstream.calls).toEqual([])
  })

  it('user reading the balance of a route with no credential at all is told so without an upstream call', async () => {
    // Given a deepseek route whose credential record and env reference both read empty
    const clock = { now: 1_700_000_000_000 }
    const upstream = upstreamOf({ status: 200, body: OFFICIAL_BALANCE })
    const usage = usageOver({
      credentials: { readRecord: async () => undefined, resolve: async () => undefined },
    }, clock, upstream.fetch)
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user asks for that route's balance
    await harness.connection.handleText(requestFrame(2, 'usage.balance', { provider: 'deepseek-official' }))
    // Then nothing was probed and the answer names the missing credential
    expect(answerOf(harness, 2).r).toEqual({ provider: 'deepseek-official', unsupported: 'no-credential' })
    expect(upstream.calls).toEqual([])
  })

  it('user reading the balance when the official endpoint answers 401 is told the probe failed', async () => {
    // Given an official route whose key the endpoint rejects
    const clock = { now: 1_700_000_000_000 }
    const upstream = upstreamOf({ status: 401, body: { error: { message: 'Authentication Fails' } } })
    const usage = usageOver({ credentials: OFFICIAL_CREDENTIALS, settings: OFFICIAL_SETTINGS }, clock, upstream.fetch)
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    // When the user asks for that route's balance
    await harness.connection.handleText(requestFrame(2, 'usage.balance', { provider: 'deepseek-official' }))
    // Then the refusal is named as a failed probe with its short reason, and no
    // amount is invented for a reading that never happened
    expect(answerOf(harness, 2).r).toEqual({ provider: 'deepseek-official', unsupported: 'probe-failed', reason: 'HTTP 401' })
    expect(upstream.calls).toHaveLength(1)
  })

  it('user reading the same balance twice inside a minute causes one upstream call, and a later read a second', async () => {
    // Given an official route that probed once already
    const clock = { now: 1_700_000_000_000 }
    const upstream = upstreamOf({ status: 200, body: OFFICIAL_BALANCE })
    const usage = usageOver({ credentials: OFFICIAL_CREDENTIALS, settings: OFFICIAL_SETTINGS }, clock, upstream.fetch)
    const harness = makeConnection({ paired: true, usage })
    await greet(harness, [CAP_USAGE])
    await harness.connection.handleText(requestFrame(2, 'usage.balance', { provider: 'deepseek-official' }))
    // When two more phones ask inside the window, at the same instant
    const [first, second] = await Promise.all([
      usage.balance('deepseek-official'),
      usage.balance('deepseek-official'),
    ])
    // Then the window served both from one reading and the single flight merged
    // the two concurrent calls into no new upstream request at all
    expect(upstream.calls).toHaveLength(1)
    expect(first).toEqual(second)
    // When the window has passed
    clock.now += BALANCE_CACHE_TTL_MS
    const later = await usage.balance('deepseek-official')
    // Then a fresh reading is asked for and the answer carries a new timestamp
    expect(upstream.calls).toHaveLength(2)
    expect(later).toEqual({
      provider: 'deepseek-official',
      currency: 'CNY',
      total: 110,
      toppedUp: 100,
      granted: 10,
      updatedAt: clock.now,
    })
  })
})
