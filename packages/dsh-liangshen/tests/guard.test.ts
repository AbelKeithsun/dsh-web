import { describe, expect, it } from 'vitest'
import { foldGuardSignal, renderGuardMessage, resolveThresholds, stepDownEffort, apply, STALL_REASONING_CHARS_BY_EFFORT, DEFAULT_STALL_REASONING_CHARS, DEFAULT_BLIND_STALL_CAP, name } from '../presets/liangshen/guard.mjs'

/** Build a step's events: optional reasoning chars, optional output. */
function step(reasoningChars, { toolCall = false, visibleText = false } = {}) {
  const events = [{ type: 'step/start' }]
  if (reasoningChars > 0) {
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'x'.repeat(reasoningChars) }] } } })
  }
  if (visibleText) {
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
  }
  if (toolCall) {
    events.push({ type: 'tool/call', data: { name: 'read', callId: 'c1', arguments: '{}' } })
    events.push({ type: 'tool/result', data: { callId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } })
  }
  return events
}

/**
 * Build a step whose reasoning block carries NO text — the shape a provider
 * persists on a route that keeps only the signature.
 */
function redactedStep({ toolCall = false, visibleText = false } = {}) {
  const events = [{ type: 'step/start' }]
  events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '', signature: 'sig' }] } } })
  if (visibleText) {
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
  }
  if (toolCall) {
    events.push({ type: 'tool/call', data: { name: 'read', callId: 'c1', arguments: '{}' } })
    events.push({ type: 'tool/result', data: { callId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } })
  }
  return events
}

/** A failing tool call/result pair with a distinct callId. */
function failingCall(callId, tool = 'bash', args = '{"cmd":"pytest"}') {
  return [
    { type: 'tool/call', data: { name: tool, callId, arguments: args } },
    { type: 'tool/result', data: { callId, error: { name: 'ToolCallError', code: 'E_FAIL' } } },
  ]
}

/** A SUCCESSFUL tool call/result pair with a distinct callId. */
function okCall(callId, tool = 'bash', args = '{"cmd":"ls"}') {
  return [
    { type: 'tool/call', data: { name: tool, callId, arguments: args } },
    { type: 'tool/result', data: { callId, message: { content: [{ type: 'text', text: 'ok' }] } } },
  ]
}

/**
 * A run of N successful model-direct shell calls, one per callId. Each call is
 * its own step boundary so the fold sees a chain of settled successes rather
 * than several calls inside one step.
 */
function shellRun(count: number, tool = 'bash') {
  const events: any[] = []
  for (let index = 0; index < count; index += 1) {
    events.push({ type: 'step/start' })
    events.push(...okCall(`s${index}`, tool, `{"cmd":"cmd-${index}"}`))
  }
  return events
}

/**
 * One bridged sub-dispatch settlement: what a `run_code` program logs for each
 * tool it calls. Used to prove the fold never counts program-internal shell
 * calls as model-direct ones.
 */
function ptcDispatch(name = 'bash') {
  return { type: 'tool/ptc-dispatch', data: { name, subCallId: `c1:ptc:1`, parentCallId: 'c1', isError: false, content: [] } }
}

describe('guard foldGuardSignal', () => {
  it('operator sees no signal on an empty or healthy stream', () => {
    // Given an empty stream and a healthy stream whose steps all produce output.
    const healthy = [
      ...step(3000, { toolCall: true }),
      ...step(2500, { visibleText: true }),
      ...step(2000, { toolCall: true }),
    ]
    // When the fold runs, Then neither reports a degeneration signal.
    expect(foldGuardSignal([]).signal).toBeUndefined()
    expect(foldGuardSignal(healthy).signal).toBeUndefined()
  })

  it('operator sees a stall on ONE runaway zero-output reasoning step (384K-scale)', () => {
    // Given a single step whose reasoning alone runs to the model's official
    // max-output scale (384K) with no tool call and no reply — the #5976 shape.
    const events = [...step(384000, {})]
    // When the fold runs, Then the per-step ladder fires immediately: waiting
    // for a second such step would burn another 384K-scale generation.
    const verdict = foldGuardSignal(events)
    expect(verdict.signal).toBe('stall')
  })

  it('operator sees a stall on one zero-output step above the max-effort floor', () => {
    // Given one step reasoning past max effort's 8000-char floor and producing nothing.
    const events = [...step(9000, {})]
    // When the fold runs at that floor, Then the per-step ladder fires. (The
    // floor is effort-adaptive: the same step stays under high/low's floor.)
    expect(foldGuardSignal(events, { stallReasoningChars: STALL_REASONING_CHARS_BY_EFFORT.max }).signal).toBe('stall')
  })

  it('operator sees no per-step stall on ordinary-brief zero-output steps', () => {
    // Given steps under the 8K floor that produce nothing but are individually
    // small — below the slow-burn cap, so neither ladder may fire.
    const events = [...step(3000, {}), ...step(3000, {}), ...step(3000, {})]
    // When the fold runs, Then no stall is reported.
    expect(foldGuardSignal(events).signal).toBeUndefined()
  })

  it('operator sees a slow-burn stall after four consecutive output-free reasoning steps', () => {
    // Given four steps that each really thought (>= 200 chars) but produced no
    // tool call and no reply — the closed loop of small plausible steps.
    const events = [...step(300, {}), ...step(500, {}), ...step(400, {}), ...step(600, {})]
    // When the fold runs, Then the global ladder fires even though no single
    // step was enormous.
    expect(foldGuardSignal(events).signal).toBe('stall')
  })

  it('operator sees the slow-burn streak reset by any output', () => {
    // Given three output-free reasoning steps, then a tool call, then three more.
    const events = [
      ...step(300, {}),
      ...step(300, {}),
      ...step(300, {}),
      ...step(2000, { toolCall: true }),
      ...step(300, {}),
      ...step(300, {}),
      ...step(300, {}),
    ]
    // When the fold runs, Then neither ladder reaches its cap.
    expect(foldGuardSignal(events).signal).toBeUndefined()
  })

  it('operator sees an echo after M identical-argument failures', () => {
    // Given the same call failing three times in a row.
    const events = [
      ...failingCall('a'),
      ...failingCall('b'),
      ...failingCall('c'),
    ]
    // When the fold runs, Then it reports an echo loop and carries the name of
    // the tool that loop is stuck on — the retry-safety evidence the breaker
    // message is classified from, never a second signal.
    const verdict = foldGuardSignal(events)
    expect(verdict.signal).toBe('echo')
    expect(verdict.tool).toBe('bash')
  })

  it('operator sees the echo streak reset on success or a different call', () => {
    // Given two failures, a success, then two more failures.
    const recovered = [
      ...failingCall('a'),
      ...failingCall('b'),
      { type: 'tool/call', data: { name: 'bash', callId: 'ok1', arguments: '{"cmd":"pytest"}' } },
      { type: 'tool/result', data: { callId: 'ok1', message: { content: [{ type: 'text', text: 'passed' }] } } },
      ...failingCall('c'),
      ...failingCall('d'),
    ]
    // When the fold runs, Then the success reset the streak and no echo fires.
    expect(foldGuardSignal(recovered).signal).toBeUndefined()
    // Given calls where no three in a row share one signature.
    const different = [
      ...failingCall('a'),
      ...failingCall('b', 'bash', '{"cmd":"ls"}'),
      ...failingCall('c', 'bash', '{"cmd":"ls"}'),
    ]
    // When the fold runs, Then the echo streak never completes.
    expect(foldGuardSignal(different).signal).toBeUndefined()
  })

  it('operator can tune the thresholds', () => {
    // Given streams under the default floors and caps.
    const sub8k = [...step(3000, {})]
    const slow = [...step(300, {}), ...step(300, {}), ...step(300, {})]
    // When the fold runs with a lower character floor or a lower slow-burn cap,
    // Then each fires on the ladder it tunes.
    expect(foldGuardSignal(sub8k, { stallReasoningChars: 2000 }).signal).toBe('stall')
    expect(foldGuardSignal(slow, { globalStallCap: 3 }).signal).toBe('stall')
  })
})

describe('guard presentation-misuse signal', () => {
  it('operator sees misuse after four successful shell calls with no program between them', () => {
    // Given four model-direct shell calls that each succeeded and no run_code
    // call anywhere in the stream.
    const events = shellRun(4)
    // When the fold runs, Then it reports the batching signal and names the
    // shell the model is stuck one-call-at-a-time on.
    const verdict = foldGuardSignal(events)
    expect(verdict.signal).toBe('misuse')
    expect(verdict.tool).toBe('bash')
    expect(verdict.detail).toContain('4 consecutive successful shell calls')
  })

  it('operator sees no misuse below the threshold or on non-shell tools', () => {
    // Given three shell calls, and four calls of a tool that is not a shell.
    const below = shellRun(3)
    const otherTool = [...okCall('r0', 'read'), ...okCall('r1', 'read'), ...okCall('r2', 'read'), ...okCall('r3', 'read')]
    // When the fold runs, Then neither is the one-call-at-a-time shell habit:
    // four reads are not the pattern this signal reports.
    expect(foldGuardSignal(below).signal).toBeUndefined()
    expect(foldGuardSignal(otherTool).signal).toBeUndefined()
  })

  it('operator sees the shell chain reset by a run_code call in between', () => {
    // Given two shell calls, a run_code program, then two more shell calls.
    const events = [...shellRun(2), ...okCall('rc', 'run_code', '{"code":"return 1"}'), ...shellRun(2)]
    // When the fold runs, Then the program broke the chain and no misuse is
    // reported: reaching for the transport is exactly what the signal asks for.
    expect(foldGuardSignal(events).signal).toBeUndefined()
  })

  it('operator sees the shell chain reset by any other tool between two commands', () => {
    // Given two shell calls, one read, then two more shell calls.
    const events = [...shellRun(2), ...okCall('mid', 'read'), ...shellRun(2)]
    // When the fold runs, Then a step the shell never asked for ends the run,
    // so four shell calls split by one read are not a four-step chain.
    expect(foldGuardSignal(events).signal).toBeUndefined()
  })

  it('operator sees the shell chain reset by a FAILED shell call', () => {
    // Given three successful shell calls, one failure, then three more.
    const events = [...shellRun(3), ...failingCall('bad'), ...shellRun(3)]
    // When the fold runs, Then a failed command is the echo ladder's business
    // and never a step of the batching chain.
    expect(foldGuardSignal(events).signal).toBeUndefined()
  })

  it('operator sees program-internal shell calls excluded from the chain', () => {
    // Given many shell calls BRIDGED from inside a program (tool/ptc-dispatch),
    // which is the batching the signal asks for rather than the pattern it
    // reports.
    const events: any[] = []
    for (let index = 0; index < 8; index += 1) events.push(ptcDispatch('bash'))
    // When the fold runs, Then those dispatches never advance the model-direct
    // chain and no misuse is reported.
    expect(foldGuardSignal(events).signal).toBeUndefined()
  })

  it('operator can tune the misuse threshold like every other cap', () => {
    // Given two successful shell calls.
    const events = shellRun(2)
    // When the fold runs at the default versus a lowered cap, Then only the
    // tuned cap reports, and the sensitivity presets scale it.
    expect(foldGuardSignal(events).signal).toBeUndefined()
    expect(foldGuardSignal(events, { shellBatchSteps: 2 }).signal).toBe('misuse')
    expect(resolveThresholds({ sensitivity: 'balanced' }).shellBatchSteps).toBe(4)
    expect(resolveThresholds({ sensitivity: 'aggressive' }).shellBatchSteps).toBe(2)
    expect(resolveThresholds({ sensitivity: 'conservative' }).shellBatchSteps).toBe(6)
    expect(resolveThresholds({ shellBatchSteps: 9 }).shellBatchSteps).toBe(9)
  })

  it('operator sees a real degeneration episode win over the batching signal', () => {
    // Given a stream that is BOTH a shell chain and a runaway reasoning step.
    const events = [...shellRun(4), ...step(384000, {})]
    // When the fold runs, Then the degeneration signal takes the episode: a
    // broken session is the more urgent fact than a batching habit.
    expect(foldGuardSignal(events).signal).toBe('stall')
  })
})

describe('guard presentation-misuse message and injection', () => {
  it('operator reads a batching nudge that names the program and claims no degeneration', () => {
    // Given a misuse verdict on a shell chain.
    const message = renderGuardMessage({ signal: 'misuse', tool: 'bash', detail: '4 consecutive successful shell calls with no run_code in between' })
    // When the message renders, Then it points at one run_code program, names
    // the count and the shell, and makes none of the degeneration claims the
    // stall and echo messages make.
    expect(message).toContain('Presentation check')
    expect(message).toContain('4 consecutive')
    expect(message).toContain('`bash`')
    expect(message).toContain('one `run_code` program')
    expect(message).toContain('return` only the conclusion')
    expect(message).not.toContain('degeneration loop')
    expect(message).not.toContain('Stop re-deriving')
    expect(message).not.toContain('effectState')
  })

  it('operator sees the stall and echo messages unchanged beside the new signal', () => {
    // Given each degeneration verdict, When the messages render, Then the
    // existing wording is intact: the new signal was added beside them, not
    // through them.
    expect(renderGuardMessage({ signal: 'stall' })).toContain('The runtime interrupted a degeneration loop: repeated long reasoning with no tool call and no reply.')
    expect(renderGuardMessage({ signal: 'echo' })).toContain('The runtime interrupted a degeneration loop: the same tool call failing repeatedly with identical arguments.')
    expect(renderGuardMessage({ signal: 'echo', tool: 'read' })).toContain('effectState none')
    expect(renderGuardMessage({ signal: 'stall' })).toContain('Stop re-deriving in thought')
  })
})
describe('guard blind-route STALL fallback', () => {
  it('operator still gets a stall on a session that never persisted reasoning text', () => {
    // Given four consecutive output-free steps whose reasoning blocks carry a
    // signature and an empty string — the redacted-route shape, where every
    // character measure reads zero.
    const events = [
      ...redactedStep({}), ...redactedStep({}), ...redactedStep({}), ...redactedStep({}),
    ]
    // When the fold runs, Then the step-count fallback fires STALL where the
    // character ladders structurally cannot.
    const verdict = foldGuardSignal(events)
    expect(verdict.signal).toBe('stall')
    expect(verdict.blind).toBe(true)
  })

  it('operator gets no blind fallback while the session still produces reasoning text', () => {
    // Given the same four output-free steps, but carrying reasoning TEXT.
    const events = [...step(300, {}), ...step(300, {}), ...step(300, {}), ...step(300, {})]
    // When the fold runs, Then the session is not blind: its own slow-burn
    // ladder is what decides, and it reports the slow-burn shape.
    const verdict = foldGuardSignal(events)
    expect(verdict.blind).toBe(false)
    expect(verdict.detail).toContain('slow burn')
  })

  it('operator gets no blind fallback from a stream with no reasoning block at all', () => {
    // Given output-free steps that carried no reasoning block (tool acks), and
    // an empty stream.
    const acks = [
      { type: 'step/start' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '' }] } } },
      { type: 'step/start' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '' }] } } },
      { type: 'step/start' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '' }] } } },
      { type: 'step/start' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '' }] } } },
    ]
    // When the fold runs, Then a session with nothing to measure is not read as
    // a degenerate one.
    expect(foldGuardSignal(acks).signal).toBeUndefined()
    expect(foldGuardSignal(acks).blind).toBe(false)
    expect(foldGuardSignal([]).blind).toBe(false)
  })

  it('operator sees the blind streak reset by any output and honour the cap', () => {
    // Given three redacted output-free steps, then a step with a tool call.
    const interrupted = [
      ...redactedStep({}), ...redactedStep({}), ...redactedStep({}),
      ...redactedStep({ toolCall: true }),
    ]
    // When the fold runs, Then the streak reset and no stall is reported.
    expect(foldGuardSignal(interrupted).signal).toBeUndefined()
    // Given three redacted output-free steps only, Then the default cap of 4
    // has not been reached either.
    expect(foldGuardSignal([...redactedStep({}), ...redactedStep({}), ...redactedStep({})]).signal).toBeUndefined()
    expect(DEFAULT_BLIND_STALL_CAP).toBe(4)
    // And the cap is the caller's to lower.
    expect(foldGuardSignal([...redactedStep({}), ...redactedStep({}), ...redactedStep({})], { blindStallCap: 3 }).signal).toBe('stall')
  })
})

describe('guard resolveThresholds (adaptive by effort and sensitivity)', () => {
  it('operator sees the floor follow the current reasoning effort', () => {
    // Given each named effort and an unknown one.
    // When thresholds resolve, Then the floor follows the budget the model was
    // asked to spend: lowest at max (where runaways happen), highest at low.
    expect(resolveThresholds({ effort: 'max' }).stallReasoningChars).toBe(STALL_REASONING_CHARS_BY_EFFORT.max)
    expect(resolveThresholds({ effort: 'high' }).stallReasoningChars).toBe(STALL_REASONING_CHARS_BY_EFFORT.high)
    expect(resolveThresholds({ effort: 'low' }).stallReasoningChars).toBe(STALL_REASONING_CHARS_BY_EFFORT.low)
    expect(resolveThresholds({ effort: 75 }).stallReasoningChars).toBe(DEFAULT_STALL_REASONING_CHARS)
    expect(resolveThresholds({}).stallReasoningChars).toBe(DEFAULT_STALL_REASONING_CHARS)
  })

  it('operator can scale every threshold with a sensitivity preset', () => {
    // Given the balanced default and the two other presets at max effort.
    // When thresholds resolve, Then conservative raises and aggressive lowers
    // both the floor and the slow-burn cap, never below their minimums.
    expect(resolveThresholds({ effort: 'max', sensitivity: 'conservative' }).stallReasoningChars).toBe(12000)
    expect(resolveThresholds({ effort: 'max', sensitivity: 'balanced' }).stallReasoningChars).toBe(8000)
    expect(resolveThresholds({ effort: 'max', sensitivity: 'aggressive' }).stallReasoningChars).toBe(4000)
    expect(resolveThresholds({ sensitivity: 'conservative' }).globalStallCap).toBe(6)
    expect(resolveThresholds({ sensitivity: 'balanced' }).globalStallCap).toBe(4)
    expect(resolveThresholds({ sensitivity: 'aggressive' }).globalStallCap).toBe(2)
    // The blind fallback is the slow-burn ladder's degraded stand-in, so it
    // carries the same scaled cap.
    expect(resolveThresholds({ sensitivity: 'conservative' }).blindStallCap).toBe(6)
    expect(resolveThresholds({ sensitivity: 'balanced' }).blindStallCap).toBe(4)
    expect(resolveThresholds({ sensitivity: 'aggressive' }).blindStallCap).toBe(2)
    expect(resolveThresholds({ globalStallCap: 7 }).blindStallCap).toBe(7)
  })

  it('operator fine-tuning overrides win over the adaptive table', () => {
    // Given an explicit override for each threshold.
    // When thresholds resolve, Then the override beats the effort table and the
    // sensitivity scale for that field only.
    expect(resolveThresholds({ effort: 'max', stallReasoningChars: 5000 }).stallReasoningChars).toBe(5000)
    expect(resolveThresholds({ globalStallCap: 7 }).globalStallCap).toBe(7)
    expect(resolveThresholds({ echoFailures: 9 }).echoFailures).toBe(9)
    // Untouched fields still follow the table.
    expect(resolveThresholds({ effort: 'low', stallReasoningChars: 5000 }).globalStallCap).toBe(4)
  })

  it('operator sees the fold honour the resolved floor per effort', () => {
    // Given one zero-output step of 9000 reasoning chars.
    const events = [...step(9000, {})]
    // When the fold runs at max effort's floor versus low effort's floor, Then
    // the same step trips the max-effort ladder but stays under the low one.
    expect(foldGuardSignal(events, resolveThresholds({ effort: 'max' })).signal).toBe('stall')
    expect(foldGuardSignal(events, resolveThresholds({ effort: 'low' })).signal).toBeUndefined()
  })
})

describe('guard stepDownEffort', () => {
  it('operator only ever steps max down, and the ladder stops at the sweet spot', () => {
    // Given the known ladder and every level outside it.
    // When a step-down is computed, Then only max moves, and it moves to high:
    // nothing is ever lowered BELOW the model's measured 60-80 sweet spot, so
    // a session the user explicitly put on high keeps that level.
    expect(stepDownEffort('max')).toBe('high')
    expect(stepDownEffort('high')).toBeUndefined()
    expect(stepDownEffort('low')).toBeUndefined()
    expect(stepDownEffort('off')).toBeUndefined()
    expect(stepDownEffort(undefined)).toBeUndefined()
    expect(stepDownEffort(75)).toBeUndefined()
  })
})

describe('guard renderGuardMessage retry safety', () => {
  it('operator reads the interrupted pattern named for each signal', () => {
    // Given each verdict, When the message renders, Then it names the pattern and the breaker.
    expect(renderGuardMessage({ signal: 'stall' })).toContain('no tool call')
    expect(renderGuardMessage({ signal: 'echo' })).toContain('identical arguments')
    expect(renderGuardMessage({ signal: 'stall' })).toContain('[Circuit Breaker]')
    expect(renderGuardMessage({ signal: 'echo' })).toContain('[Circuit Breaker]')
  })

  it('operator is told a read-only echo may be retried once its arguments are fixed', () => {
    // Given an echo verdict on a tool whose failed call cannot have left state
    // behind, so its effect is known to be none.
    const message = renderGuardMessage({ signal: 'echo', tool: 'read' })
    // When the message renders, Then it names that tool, states the effect, and
    // allows the one move that is safe here: corrected arguments, then retry.
    expect(message).toContain('effectState none')
    expect(message).toContain('retrying it is safe')
    // The verdict on THIS call is none: the unknown half is only the contrast
    // the message states for every other call shape.
    expect(message).toContain('`read`: effectState none')
    expect(message).not.toContain('`read`: effectState unknown')
  })

  it('operator is told an unknown-effect echo needs read-only verification first', () => {
    // Given an echo verdict on a call whose effect the runtime cannot know — a
    // shell command, or a batch that may have stopped halfway.
    const message = renderGuardMessage({ signal: 'echo', tool: 'bash' })
    // When the message renders, Then the model is sent to read-only inspection
    // before the next call, and told not to repeat the interrupting one.
    expect(message).toContain('effectState unknown')
    expect(message).toContain('`bash`')
    expect(message).toContain('read-only tools')
    expect(message).toContain('do NOT call it again')
    // And the read-only half stays stated, so a model that can prove the call
    // was idempotent is not blocked by the conservative default.
    expect(message).toContain('effectState none')
  })

  it('operator gets the conservative half when the breaking tool is unknown', () => {
    // Given an echo verdict naming no tool, and one naming a tool the guard has
    // never seen (an unrecognised read-only tool lands here by design).
    const nameless = renderGuardMessage({ signal: 'echo' })
    const unseen = renderGuardMessage({ signal: 'echo', tool: 'some_unseen_tool' })
    // When the messages render, Then neither promises a retry is safe: guessing
    // here would duplicate an effect that may already have landed.
    for (const message of [nameless, unseen]) {
      expect(message).toContain('effectState unknown')
      expect(message).toContain('the failing call')
    }
    expect(unseen).toContain('`some_unseen_tool`')
  })

  it('operator keeps the stalled-reasoning message free of retry advice', () => {
    // Given a stall verdict, whose cause is an over-large reasoning budget
    // rather than a broken call.
    const message = renderGuardMessage({ signal: 'stall' })
    // When the message renders, Then it keeps its original wording: there is no
    // call to classify and nothing to retry.
    expect(message).not.toContain('effectState')
    expect(message).toContain('Stop re-deriving in thought')
  })
})

describe('guard fire behaviour (signal to action)', () => {
  /** A fake agent whose session replays one event stream. */
  const agent = (events) => ({ session: { events } })

  /**
   * Mount the plugin over a fake context and return the two edges the breaker
   * hangs on: the request waterfall and the pre-step hook.
   */
  function mount(config) {
    const handlers = new Map()
    const warnings = []
    const ctx = {
      on: (event, listener) => { handlers.set(event, listener) },
      logger: { warn: (message) => { warnings.push(message) } },
    }
    apply(ctx, config)
    return {
      warnings,
      /** Run one pre-step for the agent; returns the decision the host sees. */
      preStep: (target) => handlers.get('agent/pre-step')({ agent: target }, async () => ({ kind: 'enter', messages: [] })),
      /** Run one request through the waterfall with the given resolved effort. */
      request: (target, effort) => handlers.get('agent/request')({ agent: target }, async () => ({ reasoningEffort: effort })),
    }
  }

  it('operator gets the breaker message but NO step-down when an echo fires', async () => {
    // Given a session stuck on one identical failing call, on max effort.
    const target = agent([...failingCall('a'), ...failingCall('b'), ...failingCall('c')])
    const guard = mount({})
    // When the breaker fires, Then the message is injected...
    const decision = await guard.preStep(target)
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0].content[0].text).toContain('[Circuit Breaker]')
    // The injected message carries the retry-safety half of the fold verdict:
    // the loop is stuck on a shell call, whose effect the guard cannot know.
    expect(decision.messages[0].content[0].text).toContain('effectState unknown')
    // ...and the request is left exactly as the route resolved it: an echo is a
    // broken call, so weakening the model is not the remedy.
    await expect(guard.request(target, 'max')).resolves.toEqual({ reasoningEffort: 'max' })
  })

  it('operator gets the breaker message AND the step-down when a stall fires', async () => {
    // Given a session in the runaway zero-output shape, on max effort.
    const target = agent([...step(384000, {})])
    const guard = mount({})
    // When the breaker fires, Then the message is injected...
    const decision = await guard.preStep(target)
    expect(decision.messages).toHaveLength(1)
    // ...and the next request is stepped one notch down, but never below high.
    await expect(guard.request(target, 'max')).resolves.toEqual({ reasoningEffort: 'high' })
    await expect(guard.request(target, 'high')).resolves.toEqual({ reasoningEffort: 'high' })
    // The window is bounded: after the configured requests the route's own
    // effort resumes untouched.
    await expect(guard.request(target, 'max')).resolves.toEqual({ reasoningEffort: 'high' })
    await expect(guard.request(target, 'max')).resolves.toEqual({ reasoningEffort: 'max' })
  })

  it('operator is told once when a session\'s stall detection is degraded to step counts', async () => {
    // Given a redacted-route session with no reasoning text anywhere.
    const target = agent([
      ...redactedStep({}), ...redactedStep({}), ...redactedStep({}), ...redactedStep({}),
    ])
    const guard = mount({})
    // When the fold runs twice, Then the degradation is reported exactly once.
    await guard.preStep(target)
    await guard.preStep(target)
    const blind = guard.warnings.filter((line) => line.includes('degraded to step counts'))
    expect(blind).toHaveLength(1)
  })

  it('operator gets no degradation notice for a session that carries reasoning text', async () => {
    // Given a session whose steps carry reasoning text.
    const target = agent([...step(300, {}), ...step(300, {})])
    const guard = mount({})
    // When the fold runs, Then nothing claims a degraded stall detection.
    await guard.preStep(target)
    expect(guard.warnings.filter((line) => line.includes('degraded to step counts'))).toHaveLength(0)
  })
})

describe('guard presentation-misuse injection', () => {
  /**
   * A fake agent whose session replays one event stream and whose scope either
   * carries the run_code transport or does not. The scope reads the SAME public
   * `schemas()` projection the catalog reads, so the transport probe is
   * exercised through its real input rather than a private flag.
   */
  const agent = (events: any[], { transport = true } = {}) => ({
    session: { events },
    ctx: { tools: { schemas: () => (transport ? [{ name: 'run_code' }, { name: 'bash' }] : [{ name: 'bash' }]) } },
  })

  /** Mount the guard over a fake context and return its pre-step hook. */
  function mount(config: Record<string, unknown> = {}) {
    const handlers = new Map<string, any>()
    const warnings: string[] = []
    const ctx = {
      on: (event: string, listener: any) => { handlers.set(event, listener) },
      logger: { warn: (message: string) => { warnings.push(message) } },
    }
    apply(ctx, config)
    return {
      warnings,
      preStep: (target: any) => handlers.get('agent/pre-step')({ agent: target }, async () => ({ kind: 'enter', messages: [] })),
    }
  }

  /** The injected message texts of one pre-step decision. */
  const textsOf = (decision: any) => decision.messages.map((message: any) => message.content[0].text)

  it('operator gets one batching nudge on a shell chain and is not nagged again in the same episode', async () => {
    // Given a session running four shell calls one at a time carrying run_code.
    const target = agent(shellRun(4))
    const guard = mount({ refireCooldownSteps: 1 })
    // When the fold runs on the SAME stream twice, Then the nudge lands once:
    // the episode is the chain, not the request.
    const first = await guard.preStep(target)
    expect(first.messages).toHaveLength(1)
    expect(textsOf(first)[0]).toContain('Presentation check')
    expect(textsOf(first)[0]).toContain('4 consecutive')
    const second = await guard.preStep(target)
    expect(second.messages).toHaveLength(0)
  })

  it('operator gets no nudge once a program breaks the chain', async () => {
    // Given a shell chain a program interrupted halfway through.
    const target = agent([...shellRun(2), ...okCall('rc', 'run_code', '{"code":"return 1"}'), ...shellRun(2)])
    const guard = mount({})
    // When the fold runs, Then no nudge is injected: the model already batched.
    const decision = await guard.preStep(target)
    expect(decision.messages).toHaveLength(0)
  })

  it('operator gets no nudge in a session whose wire carries no run_code', async () => {
    // Given the same four-call chain, but a scope that opens no transport —
    // the native presentation, where advising a program would name a tool the
    // request does not carry.
    const target = agent(shellRun(4), { transport: false })
    const guard = mount({})
    // When the fold runs, Then nothing is injected and no request is touched.
    const decision = await guard.preStep(target)
    expect(decision.messages).toHaveLength(0)
  })

  it('operator sees a resumed chain count as a new episode while a continuing one does not', () => {
    // Given two streams that both end with four consecutive shell calls: one
    // where an earlier chain was broken by a program, and one where the SAME
    // chain simply keeps going past its own report point.
    const resumed = [
      ...shellRun(4),
      ...okCall('rc', 'run_code', '{"code":"return 1"}'),
      ...shellRun(4),
    ]
    const continuing = shellRun(6)
    // When the fold runs on each, Then the generation counter is what tells
    // the two apart: the break advanced it, so a session that returns to
    // one-at-a-time shell work is a NEW episode deserving one more nudge,
    // while a chain that never broke reports once and holds.
    expect(foldGuardSignal(resumed).generation).toBe(1)
    expect(foldGuardSignal(continuing).generation).toBe(0)
    // The streak itself resets at the break, so a resumed chain reports its
    // OWN length rather than a running total across both episodes.
    expect(foldGuardSignal(resumed).detail).toContain('4 consecutive')
    expect(foldGuardSignal(continuing).detail).toContain('6 consecutive')
  })

  it('operator sees the batching nudge leave the degeneration breaker untouched', async () => {
    // Given a session that first draws the batching nudge, then goes on to a
    // real runaway-reasoning episode.
    const target = agent([...shellRun(4), ...step(384000, {})])
    const guard = mount({})
    // When the fold runs for the nudge step alone, then for the full stream,
    // Then the nudge consumed none of the DEgeneration breaker's budget: the
    // stall still fires with its step-down window intact. A batching hint must
    // never delay the breaker an operator is actually relying on.
    const nudge = await guard.preStep(agent(shellRun(4)))
    expect(textsOf(nudge)[0]).toContain('Presentation check')
    const stalled = await guard.preStep(target)
    expect(textsOf(stalled)[0]).toContain('Stop re-deriving in thought')
  })
  it('operator still gets the degeneration breaker on the same session shape', async () => {
    // Given a chain of shell calls whose last step is a runaway reasoning step,
    // so the same stream carries both the batch habit and a real episode.
    const target = agent([...shellRun(4), ...step(384000, {})])
    const guard = mount({})
    // When the fold runs, Then the DEGENERATION message is what lands: the
    // existing signals keep their text and their priority.
    const decision = await guard.preStep(target)
    expect(decision.messages).toHaveLength(1)
    expect(textsOf(decision)[0]).toContain('degeneration loop')
    expect(textsOf(decision)[0]).toContain('Stop re-deriving in thought')
    expect(textsOf(decision)[0]).not.toContain('Presentation check')
  })
})
describe('guard plugin identity', () => {
  it('operator can rely on the stable cordis plugin name', () => {
    // Given the plugin module, When its name is read, Then it is the stable id.
    expect(name).toBe('liangshen-guard')
  })
})
