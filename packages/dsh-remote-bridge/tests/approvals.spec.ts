import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalRegistry } from '../src/core/approvals.ts'
import { approvalSummary } from '../src/core/hub.ts'
import { answerOf, makeConnection, makeHub, requestFrame, type RecordingTransport } from './support/harness.ts'

/** The one approval question a hub published, as a phone reads it. */
function publishedQuestion(transport: RecordingTransport): { sessionId: string; id: string; summary: string; toolName: string } {
  const frame = transport.ofType('ev').find(candidate => candidate.m === 'approval.request')
  if (frame === undefined) throw new Error('no approval question was published')
  return frame.p as { sessionId: string; id: string; summary: string; toolName: string }
}

describe('approval bridge', () => {
  afterEach(() => { vi.useRealTimers() })

  it('operator claims a question and answers it exactly once', async () => {
    // Given a registry with one open question
    const registry = new ApprovalRegistry({ random: () => 'q-1' })
    const prompt = registry.open({ sessionId: 's-1', toolName: 'bash', summary: 'run a command' })
    // When it is answered twice
    const first = registry.resolve('q-1', 'allowed-once')
    const second = registry.resolve('q-1', 'rejected')
    // Then the first answer settles the question and the second finds nothing to settle
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(await prompt.answer).toBe('allowed-once')
    expect(registry.size).toBe(0)
  })

  it('operator never answers and the question is delegated when its timeout elapses', async () => {
    // Given a claimed question whose phone goes quiet
    vi.useFakeTimers()
    const registry = new ApprovalRegistry({ timeoutMs: 120_000, random: () => 'q-2' })
    const prompt = registry.open({ sessionId: 's-1', toolName: 'bash', summary: 'run a command' })
    // When the timeout elapses
    await vi.advanceTimersByTimeAsync(120_000)
    // Then the answer is withdrawal, which the Host reads as the fail-closed unavailable
    expect(await prompt.answer).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('operator cancels the agent turn and the question is withdrawn before its timeout', async () => {
    // Given a claimed question and the agent's own cancellation lifetime
    const controller = new AbortController()
    const registry = new ApprovalRegistry({ random: () => 'q-3' })
    const prompt = registry.open({ sessionId: 's-1', toolName: 'bash', summary: 'run a command', signal: controller.signal })
    // When the asker withdraws
    controller.abort()
    // Then the question settles immediately
    expect(await prompt.answer).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('user answering a claimed question gives the agent exactly that decision', async () => {
    // Given a hub whose question was published to a paired device
    const harness = makeHub()
    const pending = harness.hub.approve({ agent: { id: 's-1' }, toolName: 'bash', displayReason: { en: 'run a command', zh: '运行命令' } }, async () => 'unavailable')
    const question = publishedQuestion(harness.transport)
    // When the user allows it once
    await harness.connection.handleText(requestFrame(1, 'approval.resolve', { id: question.id, decision: 'allowed-once' }))
    // Then the agent receives that decision and the phone saw the question in its own language
    expect(question.sessionId).toBe('s-1')
    expect(question.summary).toBe('运行命令')
    expect(await pending).toBe('allowed-once')  })

  it('user rejecting a claimed question gives the agent a refusal', async () => {
    // Given a hub whose question was published to a paired device
    const harness = makeHub()
    const pending = harness.hub.approve({ agent: { id: 's-1' }, toolName: 'bash' }, async () => 'unavailable')
    const question = publishedQuestion(harness.transport)
    // When the user rejects it
    await harness.connection.handleText(requestFrame(2, 'approval.resolve', { id: question.id, decision: 'rejected' }))
    // Then the agent receives the refusal rather than the fail-closed default
    expect(await pending).toBe('rejected')
    expect(question.summary).toBe('bash')
  })

  it('user answering a question twice has the second answer refused as unknown', async () => {
    // Given a question already answered
    const harness = makeHub()
    const pending = harness.hub.approve({ agent: { id: 's-1' }, toolName: 'bash' }, async () => 'unavailable')
    const question = publishedQuestion(harness.transport)
    await harness.connection.handleText(requestFrame(3, 'approval.resolve', { id: question.id, decision: 'allowed-once' }))
    // When the same id is answered again
    await harness.connection.handleText(requestFrame(4, 'approval.resolve', { id: question.id, decision: 'rejected' }))
    // Then the stale answer is refused and the first decision stands
    expect(answerOf(harness, 4).e?.code).toBe('approval-unknown')
    expect(await pending).toBe('allowed-once')
  })

  it('user answering a question nobody asked is refused as unknown', async () => {
    // Given a paired connection
    const harness = makeConnection({ paired: true })
    // When it answers a question id that was never issued
    await harness.connection.handleText(requestFrame(5, 'approval.resolve', { id: 'q-nothing', decision: 'allowed-once' }))
    // Then the refusal is unknown, not a claim on somebody else's question
    expect(answerOf(harness, 5).e?.code).toBe('approval-unknown')
  })

  it('operator loses the last phone and the claimed question is delegated', async () => {
    // Given a claimed question on a hub whose only device is about to go away
    const harness = makeHub()
    const pending = harness.hub.approve({ agent: { id: 's-1' }, toolName: 'bash' }, async () => 'unavailable')
    // When the connection closes
    harness.hub.detach(harness.connection)
    // Then the agent is not left waiting for a phone that is gone
    expect(await pending).toBe('unavailable')
  })

  it('operator runs with no paired device and the question never leaves the host', async () => {
    // Given a hub whose only connection is unpaired
    const harness = makeHub({ paired: false })
    // When the agent asks
    const pending = harness.hub.approve({ agent: { id: 's-1' }, toolName: 'bash' }, async () => 'unavailable')
    // Then nothing was published and the next answerer decides
    expect(harness.transport.ofType('ev')).toEqual([])
    expect(await pending).toBe('unavailable')
    expect(harness.hub.pairedClients).toBe(0)
  })

  it('operator reads the question summary in the operator language before the tool name', () => {
    // Given three questions, one localized in Chinese, one only in English, one not localized at all
    const summaries = [
      approvalSummary({ agent: { id: 's-1' }, toolName: 'bash', displayReason: { en: 'run a command', zh: '运行命令' } }),
      approvalSummary({ agent: { id: 's-1' }, toolName: 'bash', displayReason: { en: 'run a command' } }),
      approvalSummary({ agent: { id: 's-1' }, toolName: 'bash' }),
    ]
    // When the phone's summary line is built
    // Then the Chinese presentation wins, then English, then the tool name
    expect(summaries).toEqual(['运行命令', 'run a command', 'bash'])
  })

  it('operator abandons every pending question when the bridge unloads', async () => {
    // Given two claimed questions
    const harness = makeHub()
    const first = harness.hub.approve({ agent: { id: 's-1' }, toolName: 'bash' }, async () => 'unavailable')
    const second = harness.hub.approve({ agent: { id: 's-2' }, toolName: 'read' }, async () => 'unavailable')
    // When the plugin is torn down
    harness.hub.dispose()
    // Then both are delegated and no timer is left holding the process
    expect(await first).toBe('unavailable')
    expect(await second).toBe('unavailable')
    expect(harness.approvals.size).toBe(0)
  })
})
