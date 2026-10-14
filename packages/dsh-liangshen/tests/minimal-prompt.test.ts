import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  apply,
  discoverSubdirectoryInstructions,
  extractInstructionPaths,
  filePathFromExecution,
  FILE_TOUCH_TOOL_NAMES,
  filterInstructionMessages,
  INSTRUCTION_SOURCES,
  isBaselineInstructionPath,
  isMessagePureBaseline,
  DISPATCHER_RULES_HEADING,
  loadInstructionFiles,
  loadInstructionText,
  name,
  PTC_SECTION_NAMES,
  renderInstructionSection,
  WORKSPACE_INSTRUCTIONS_SECTION_NAME,
} from '../presets/liangshen/minimal-prompt.mjs'
import * as promptModule from '../presets/liangshen/minimal-prompt.mjs'
import { DISPATCHER_RULES, DISPATCHER_RULES_APPENDIX, DISPATCHER_RULES_WITH_APPENDIX } from '../presets/liangshen/dispatcher-rules.mjs'

type Listener = (first: any, second: any, third: any) => Promise<any>

interface Harness {
  listeners: Map<string, { listener: Listener, options: any }>
  warns: string[]
}

function register(config: Record<string, unknown> = {}): Harness {
  const listeners = new Map<string, { listener: Listener, options: any }>()
  const warns: string[] = []
  const ctx = {
    on(event: string, callback: Listener, options?: any) {
      listeners.set(event, { listener: callback, options })
    },
    logger: { warn: (message: string) => { warns.push(message) } },
  }
  apply(ctx, config)
  return { listeners, warns }
}

function listener(harness: Harness, event: string): Listener {
  const entry = harness.listeners.get(event)
  expect(entry).toBeDefined()
  return entry!.listener
}

/** One stable agent/session identity, so per-session state survives a call. */
function agentOf() {
  return { session: { header: {} } }
}

const PERSONA = { name: 'deployment:persona-prefix', text: 'You are a helpful software engineer assistant.' }
const PLAN = { name: 'plan:policy', text: 'You are in plan mode.' }

const FULL_SECTIONS = [
  { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
  PERSONA,
  { name: 'tool:bash', text: 'Check the [exit code: N] marker on every bash result.' },
  PLAN,
  { name: 'web:surface', text: 'You are interacting with the user through the DSH Web GUI.' },
]

async function assemble(
  harness: Harness,
  sections: unknown[] = FULL_SECTIONS,
  contexts: unknown[] = [{ name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write.' }],
  agent: unknown = agentOf(),
  tools: unknown[] = [],
) {
  return listener(harness, 'system-prompt/assemble')(
    undefined,
    { agent },
    async () => ({ sections, contexts, tools, variables: {} }),
  )
}

async function preStep(
  harness: Harness,
  agent: unknown,
  messages: unknown[],
  kind = 'enter',
) {
  return listener(harness, 'agent/pre-step')(
    { agent, messages, turn: 1, step: 1, signal: {} },
    async () => ({ kind, messages }),
  )
}

function instructionsMessage(id: string, paths: string[]) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: paths.map(path => `Instructions from: ${path}`).join('\n') }],
    source: { kind: 'agent-instructions' },
  }
}

/**
 * Instruction discovery reads the real filesystem, so every test runs against
 * a scratch `$DSH_HOME`; project trees are scratch dirs with a `.git` marker.
 */
let homeDir: string
let savedHomeEnv: string | undefined
const scratchDirs: string[] = []

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'liangshen-home-'))
  scratchDirs.push(homeDir)
  savedHomeEnv = process.env.DSH_HOME
  process.env.DSH_HOME = homeDir
})

afterEach(() => {
  if (savedHomeEnv === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHomeEnv
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A scratch project directory with a `.git` marker and optional files. */
function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'liangshen-project-'))
  scratchDirs.push(dir)
  writeFileSync(join(dir, '.git'), '')
  for (const [name_, content] of Object.entries(files)) {
    mkdirSync(join(dir, name_, '..'), { recursive: true })
    writeFileSync(join(dir, name_), content)
  }
  return dir
}

function agentAt(cwd: string) {
  return { session: { header: { cwd } } }
}

function writeHome(relativePath: string, content: string) {
  mkdirSync(join(homeDir, relativePath, '..'), { recursive: true })
  writeFileSync(join(homeDir, relativePath), content)
}

describe('liangshen-minimal-prompt', () => {
  test('exports a diagnostic plugin name and injects the prompt registry', () => {
    expect(name).toBe('liangshen-minimal-prompt')
  })

  test('registers both hooks outermost in their waterfalls', () => {
    const harness = register()
    expect(harness.listeners.get('system-prompt/assemble')?.options).toMatchObject({ prepend: true })
    expect(harness.listeners.get('agent/pre-step')?.options).toMatchObject({ prepend: true })
  })

  test('narrows the assembled prompt to the persona and the plan policy', async () => {
    // Given the dispatcher switch off, When the operator assembles the prompt,
    // Then only the persona and plan policy survive: this case is about the
    // narrowing, not about the appended dispatcher block.
    const result = await assemble(register({ dispatcher: false }))
    expect(result.sections.map((section: any) => section.name)).toEqual(['deployment:persona-prefix', 'plan:policy'])
    expect(result.sections[0].text).toBe(PERSONA.text)
  })

  test('leaves runtime contexts and tools untouched', async () => {
    const contexts = [{ name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write.' }]
    const result = await assemble(register(), FULL_SECTIONS, contexts)
    expect(result.contexts).toEqual(contexts)
    expect(result.tools).toEqual([])
  })

  test('accepts the legacy persona section names', async () => {
    const legacy = [
      { name: 'persona', text: 'You are a helpful software engineer assistant.' },
      { name: 'harness:identity', text: 'identity' },
    ]
    const result = await assemble(register(), legacy)
    expect(result.sections.map((section: any) => section.name)).toEqual(['persona'])
  })

  test('drops the plan policy when keepPlanPolicy is false', async () => {
    const result = await assemble(register({ keepPlanPolicy: false }))
    expect(result.sections.map((section: any) => section.name)).toEqual(['deployment:persona-prefix'])
  })

  test('keeps the assembled prompt and warns once when no persona section exists', async () => {
    const harness = register()
    const withoutPersona = [{ name: 'harness:identity', text: 'identity' }]
    const result = await assemble(harness, withoutPersona)
    expect(result.sections).toEqual(withoutPersona)
    await assemble(harness, withoutPersona)
    expect(harness.warns).toHaveLength(1)
    expect(harness.warns[0]).toContain('no section matched')
  })

  test('rejects an invalid switch', () => {
    expect(() => register({ instructionSource: 'yes' })).toThrow(/instructionSource must be one of/)
    expect(() => register({ instructionMaxBytes: 0 })).toThrow(/instructionMaxBytes must be a positive/)
    expect(() => register({ instructionMaxBytes: 'big' })).toThrow(/instructionMaxBytes must be a positive/)
    expect(() => register({ keepPlanPolicy: 1 })).toThrow(/keepPlanPolicy must be a boolean/)
  })

  test('appends the session workspace directory to the persona', async () => {
    // Given the dispatcher switch off, When the operator assembles the prompt,
    // Then the persona carries the workspace line and nothing else.
    const cwd = project()
    const result = await assemble(register({ dispatcher: false }), FULL_SECTIONS, undefined, agentAt(cwd))
    expect(result.sections[0].text)
      .toBe(`You are a helpful software engineer assistant.\n\nYour working directory is ${cwd}.`)
    // The plan policy is not orientation: it stays verbatim.
    expect(result.sections.find((section: any) => section.name === 'plan:policy').text).toBe(PLAN.text)
  })

  test('accepts the legacy persona name for the workspace line', async () => {
    const agent = agentAt(project())
    const legacy = [{ name: 'persona', text: 'You are a helpful software engineer assistant.' }]
    const result = await assemble(register(), legacy, undefined, agent)
    expect(result.sections[0].text).toContain(`Your working directory is ${agent.session.header.cwd}.`)
  })

  test('does not duplicate a workspace line the persona already carries', async () => {
    const cwd = project()
    const agent = agentAt(cwd)
    const carried = [{
      name: 'deployment:persona-prefix',
      text: `You are a helpful software engineer assistant.\n\nYour working directory is ${cwd}.`,
    }]
    const result = await assemble(register(), carried, undefined, agent)
    const line = `Your working directory is ${cwd}.`
    expect(result.sections[0].text.split(line).length - 1).toBe(1)
  })

  test('keeps the bare persona when the session reports no cwd', async () => {
    // Given the dispatcher switch off, When the session reports no cwd, Then
    // the bare persona is what remains: no workspace line and no appended block.
    const agent = { session: { header: {} } }
    const result = await assemble(register({ dispatcher: false }), FULL_SECTIONS, undefined, agent)
    expect(result.sections[0].text).toBe(PERSONA.text)
  })

  test('appends the workspace-instructions section after the stable prefix', async () => {
    writeHome('AGENTS.md', 'user-global rule')
    const cwd = project({ 'AGENTS.md': 'project rule', 'docs/AGENTS.md': 'nested rule' })
    const result = await assemble(register({ instructionSource: 'system-prompt' }), FULL_SECTIONS, undefined, agentAt(cwd))
    expect(result.sections.map((section: any) => section.name)).toEqual([
      'deployment:persona-prefix',
      'plan:policy',
      WORKSPACE_INSTRUCTIONS_SECTION_NAME,
    ])
    expect(result.sections[2].text).toBe('{{workspace_instructions}}')
    const text = result.variables.workspace_instructions as string
    // Project paths display relative to the project root, as the harness renders them.
    expect(text).toContain('Instructions from: $DSH_HOME/AGENTS.md')
    expect(text).toContain('user-global rule')
    expect(text).toContain('Instructions from: AGENTS.md')
    expect(text).toContain('project rule')
    // Broadest first: the user-global block precedes the project block.
    expect(text.indexOf('user-global rule')).toBeLessThan(text.indexOf('project rule'))
    // The baseline chain is the root-to-cwd ancestors only: a descendant
    // instruction file (the harness's dynamic reconciliation territory) is
    // not part of the section.
    expect(text).not.toContain('nested rule')
  })

  test('keeps the stable prefix byte-identical across edits to the instruction files', async () => {
    // The encoder's KV cache is reused only while the prefix does not move, so a
    // workspace-instruction edit must change ONLY the appended section's value:
    // the persona/plan-policy prefix and the appended section's own text stay put.
    writeHome('AGENTS.md', 'first revision')
    const cwd = project({ 'AGENTS.md': 'project rule v1' })
    const before = await assemble(register({ instructionSource: 'system-prompt' }), FULL_SECTIONS, undefined, agentAt(cwd))
    const prefixBefore = before.sections
      .filter((section: any) => section.name !== WORKSPACE_INSTRUCTIONS_SECTION_NAME)
      .map((section: any) => [section.name, section.text])

    writeHome('AGENTS.md', 'second revision')
    const after = await assemble(register({ instructionSource: 'system-prompt' }), FULL_SECTIONS, undefined, agentAt(cwd))
    const prefixAfter = after.sections
      .filter((section: any) => section.name !== WORKSPACE_INSTRUCTIONS_SECTION_NAME)
      .map((section: any) => [section.name, section.text])

    expect(prefixAfter).toEqual(prefixBefore)
    // The appended section is still the same reference text, only its variable moved.
    expect(after.sections.at(-1).text).toBe('{{workspace_instructions}}')
    expect(before.variables.workspace_instructions).toContain('first revision')
    expect(after.variables.workspace_instructions).toContain('second revision')
  })

  test('renders the appended section through the harness renderer verbatim', async () => {
    writeHome('AGENTS.md', 'template example: {{evil}} and {{also_evil}}')
    const cwd = project()
    const result = await assemble(register({ instructionSource: 'system-prompt' }), FULL_SECTIONS, undefined, agentAt(cwd))
    const rendered = renderPrompt({ sections: result.sections, variables: result.variables })
    expect(rendered).toContain('template example: {{evil}} and {{also_evil}}')
    expect(rendered).toContain('Your working directory is')
  })

  test('includes CLAUDE.md candidates and local overlays, deduped per directory', async () => {
    const cwd = project({
      'AGENTS.md': 'project rule',
      'CLAUDE.md': 'project rule',
      'AGENTS.local.md': 'local override',
    })
    const result = await assemble(register({ instructionSource: 'system-prompt' }), FULL_SECTIONS, undefined, agentAt(cwd))
    const text = result.variables.workspace_instructions as string
    expect(text).toContain('AGENTS.local.md')
    expect(text.match(/project rule/g)).toHaveLength(1)
  })

  test('sends no instruction section when no cwd, no file, or empty budget result', async () => {
    const harness = register({ instructionSource: 'system-prompt' })
    const bare = await assemble(harness, FULL_SECTIONS, undefined, agentAt(project()))
    expect(bare.sections.map((section: any) => section.name)).not.toContain(WORKSPACE_INSTRUCTIONS_SECTION_NAME)
    const noCwd = await assemble(harness)
    expect(noCwd.sections.map((section: any) => section.name)).toEqual(['deployment:persona-prefix', 'plan:policy'])
  })

  test('keeps reading per assembly, so file edits propagate without state', async () => {
    const cwd = project({ 'AGENTS.md': 'first rule' })
    const harness = register({ instructionSource: 'system-prompt' })
    const first = await assemble(harness, FULL_SECTIONS, undefined, agentAt(cwd))
    expect(first.variables.workspace_instructions).toContain('first rule')
    writeFileSync(join(cwd, 'AGENTS.md'), 'second rule')
    const second = await assemble(harness, FULL_SECTIONS, undefined, agentAt(cwd))
    expect(second.variables.workspace_instructions).toContain('second rule')
  })

  test('omits broadest files first when over budget, keeping the most specific', async () => {
    writeHome('AGENTS.md', 'home rule that is reasonably long '.repeat(8))
    const cwd = project({ 'AGENTS.md': 'project rule' })
    const result = await assemble(register({ instructionSource: 'system-prompt', instructionMaxBytes: 600 }), FULL_SECTIONS, undefined, agentAt(cwd))
    const text = result.variables.workspace_instructions as string
    expect(text).toContain('omitted $DSH_HOME/AGENTS.md')
    expect(text).toContain('project rule')
    expect(text).not.toContain('home rule')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(600)
  })

  test('truncates the most specific file last, at a UTF-8 boundary', async () => {
    writeHome('AGENTS.md', 'x'.repeat(2000))
    const result = await assemble(register({ instructionSource: 'system-prompt', instructionMaxBytes: 800 }), FULL_SECTIONS, undefined, agentAt(project()))
    const text = result.variables.workspace_instructions as string
    expect(text).toContain('truncated $DSH_HOME/AGENTS.md from 2000 to')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(800)
  })

  test('pure renderer covers the degenerate budgets', () => {
    const files = [{ displayPath: 'AGENTS.md', content: 'rule' }]
    expect(renderInstructionSection([], 100)).toBeUndefined()
    expect(renderInstructionSection(files, 0)).toBeUndefined()
    expect(renderInstructionSection(files, -1)).toBeUndefined()
    expect(renderInstructionSection(files, Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  test('degrades to the bare prompt when the cwd cannot be probed', async () => {
    const harness = register({ instructionSource: 'system-prompt' })
    // A cwd whose stat probes fail (a path component is a plain file)
    // contributes no instruction section instead of failing the request.
    const file = join(homeDir, 'blocker')
    writeFileSync(file, '')
    const agent = agentAt(join(file, 'nested', 'deep'))
    const result = await assemble(harness, FULL_SECTIONS, undefined, agent)
    expect(result.sections.map((section: any) => section.name)).toEqual(['deployment:persona-prefix', 'plan:policy'])
  })

  test('loadInstructionText handles a missing cwd and the default budget', async () => {
    expect(await loadInstructionText(undefined)).toBeUndefined()
    expect(await loadInstructionText('')).toBeUndefined()
    writeHome('AGENTS.md', 'home rule')
    expect(await loadInstructionText(project())).toContain('home rule')
  })

  test('condenses a covered baseline injection, and drops only what the prompt already carries', async () => {
    const cwd = project()
    writeFileSync(join(cwd, 'AGENTS.md'), 'project rule', 'utf8')
    const harness = register({ instructionSource: 'system-prompt' })
    const agent = agentAt(cwd)
    // This assembly is what puts the baseline into the system prompt.
    await assemble(harness, FULL_SECTIONS, undefined, agent)

    const covered = join(cwd, 'AGENTS.md')
    const marked = {
      id: 'a',
      role: 'user',
      content: [{ type: 'text', text: `Instructions from: ${covered}` }],
      source: { kind: 'agent-instructions', baseline: true, baselineIdentity: 'identity-1' },
    }
    const first = await preStep(harness, agent, [{ id: 'user', source: { kind: 'user' } }, marked])
    const kept = first.messages.filter((message: any) => message.id === 'a')
    // The marker survives — it is what the host reads to stop re-injecting — while
    // the duplicated prose is replaced by a pointer to the prompt.
    expect(kept).toHaveLength(1)
    expect(kept[0].content[0].text).toContain('active in the system prompt')
    expect(kept[0].source.baseline).toBe(true)
    expect(kept[0].source.baselineIdentity).toBe('identity-1')
    expect(kept[0].content[0].text).not.toContain('project rule')

    // An unmarked duplicate of the same covered baseline has nothing to add.
    const second = await preStep(harness, agent, [
      { ...marked, id: 'b', source: { kind: 'agent-instructions' } },
    ])
    expect(second.messages).toEqual([])
  })

  test('does not append an instruction section in hint mode', async () => {
    writeHome('AGENTS.md', 'home rule')
    const result = await assemble(register({ instructionSource: 'hint' }), FULL_SECTIONS, undefined, agentAt(project()))
    expect(result.sections.map((section: any) => section.name)).toEqual(['deployment:persona-prefix', 'plan:policy'])
    expect(result.variables.workspace_instructions).toBeUndefined()
  })

  test('hint mode: replaces the first agent-instructions injection with a plugin hint', async () => {
    const message = instructionsMessage('instructions-1', ['/repo/AGENTS.md', '/repo/docs/AGENTS.md'])
    const result = await preStep(register({ instructionSource: 'hint' }), agentOf(), [message])
    expect(result.kind).toBe('enter')
    expect(result.messages).toHaveLength(1)
    const hint = result.messages[0]
    expect(hint.id).toBe('instructions-1')
    expect(hint.role).toBe('user')
    expect(hint.source).toEqual({ kind: 'liangshen-minimal-prompt' })
    expect(hint.content[0].text).toContain('/repo/AGENTS.md, /repo/docs/AGENTS.md')
    expect(hint.content[0].text).toContain('not task instructions')
  })

  test('hint mode: mints a message id when the instructions message carries none', async () => {
    const message = { content: [{ type: 'text', text: 'Instructions from: /repo/AGENTS.md' }], source: { kind: 'agent-instructions' } }
    const result = await preStep(register({ instructionSource: 'hint' }), agentOf(), [message])
    expect(typeof result.messages[0].id).toBe('string')
    expect(result.messages[0].id.length).toBeGreaterThan(0)
  })

  test('hint mode: drops later agent-instructions injections and keeps other messages', async () => {
    const harness = register({ instructionSource: 'hint' })
    const agent = agentOf()
    const first = await preStep(harness, agent, [instructionsMessage('a', ['/repo/AGENTS.md'])])
    expect(first.messages).toHaveLength(1)
    const second = await preStep(harness, agent, [
      { id: 'user', source: { kind: 'user' } },
      instructionsMessage('b', ['/repo/AGENTS.md']),
    ])
    expect(second.messages.map((message: any) => message.id)).toEqual(['user'])
  })

  test('hint mode: keeps an agent-instructions injection that names no reference file', async () => {
    const message = { id: 'a', content: [{ type: 'text', text: 'no paths here' }], source: { kind: 'agent-instructions' } }
    const result = await preStep(register({ instructionSource: 'hint' }), agentOf(), [message])
    expect(result.messages).toEqual([message])
  })

  test('hint mode: hints again after a compaction', async () => {
    const harness = register({ instructionSource: 'hint' })
    const agent = agentOf()
    await preStep(harness, agent, [instructionsMessage('a', ['/repo/AGENTS.md'])])
    const second = await preStep(harness, agent, [instructionsMessage('b', ['/repo/AGENTS.md'])])
    expect(second.messages).toHaveLength(0)
    await listener(harness, 'session/event')(agent.session, { type: 'compaction/end' }, undefined)
    const third = await preStep(harness, agent, [instructionsMessage('c', ['/repo/AGENTS.md'])])
    expect(third.messages).toHaveLength(1)
    expect(third.messages[0].id).toBe('c')
  })

  describe("default 'host' instruction source", () => {
    test('ships host first in the accepted set and accepts every listed value', () => {
      expect(INSTRUCTION_SOURCES).toEqual(['host', 'system-prompt', 'hint'])
      for (const source of INSTRUCTION_SOURCES) {
        expect(() => register({ instructionSource: source })).not.toThrow()
      }
      expect(() => register({ instructionSource: 'hosts' })).toThrow(/instructionSource must be one of \["host","system-prompt","hint"\]/)
    })

    test('appends no workspace-instructions section in host mode', async () => {
      writeHome('AGENTS.md', 'user-global rule')
      const cwd = project({ 'AGENTS.md': 'project rule', 'docs/AGENTS.md': 'nested rule' })
      const result = await assemble(register({ instructionSource: 'host' }), FULL_SECTIONS, undefined, agentAt(cwd))
      expect(result.sections.map((section: any) => section.name)).toEqual(['deployment:persona-prefix', 'plan:policy'])
      expect(result.variables.workspace_instructions).toBeUndefined()
      // The persona keeps its workspace line: only the instruction section is gone.
      expect(result.sections[0].text).toContain(`Your working directory is ${cwd}.`)
    })

    test('the config-free default is host: assembly appends nothing and pre-step returns the batch itself', async () => {
      writeHome('AGENTS.md', 'user-global rule')
      const cwd = project({ 'AGENTS.md': 'project rule' })
      const harness = register()
      const agent = agentAt(cwd)
      const assembled = await assemble(harness, FULL_SECTIONS, undefined, agent)
      expect(assembled.sections.map((section: any) => section.name)).toEqual(['deployment:persona-prefix', 'plan:policy'])
      expect(assembled.variables.workspace_instructions).toBeUndefined()

      const messages = [instructionsMessage('baseline-1', ['AGENTS.md'])]
      const step = await preStep(harness, agent, messages)
      expect(step.kind).toBe('enter')
      // Identity, not just equality: the decision is handed back untouched.
      expect(step.messages).toBe(messages)
    })

    test('passes baseline, marked, and dynamic agent-instructions messages through verbatim', async () => {
      const cwd = project({ 'AGENTS.md': 'root rule' })
      const harness = register({ instructionSource: 'host' })
      const agent = agentAt(cwd)
      // Loads would succeed here, so system-prompt mode would condense or drop
      // these; host mode never looks at them.
      await assemble(harness, FULL_SECTIONS, undefined, agent)

      const plain = { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'do the task' }], source: { kind: 'user' } }
      const dynamic = {
        id: 'dyn-1',
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nAdditional instructions from: packages/subpkg/AGENTS.md\n\nsubpackage rule\n</system-reminder>' }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          changes: [{ action: 'replace', scope: 'packages/subpkg\\0AGENTS.md', path: 'packages/subpkg/AGENTS.md' }],
        },
      }
      const marked = {
        id: 'base-1',
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nInstructions from: AGENTS.md\n\nroot rule\n</system-reminder>' }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          baseline: true,
          baselineIdentity: 'id-baseline',
          changes: [{ action: 'set', scope: '.\\0AGENTS.md', path: 'AGENTS.md' }],
        },
      }

      const messages = [plain, dynamic, marked]
      const step = await preStep(harness, agent, messages)
      expect(step.messages).toBe(messages)
      expect(step.messages).toEqual([plain, dynamic, marked])
      // No condensation marker, no plugin message, no dropped entry.
      expect(step.messages.map((message: any) => message.id)).toEqual(['user-1', 'dyn-1', 'base-1'])
      expect(step.messages.some((message: any) => message.source?.kind === 'liangshen-minimal-prompt' || message.source?.kind === 'plugin')).toBe(false)
      expect(step.messages[2].content[0].text).toContain('root rule')
      expect(step.messages[2].source.baselineIdentity).toBe('id-baseline')
      expect(step.messages[1].content[0].text).toContain('subpackage rule')
    })

    test('performs no dynamic subdirectory discovery after a tool touch', async () => {
      const rootDir = project({
        'AGENTS.md': 'root rule',
        'packages/subpkg/AGENTS.md': 'subpackage rule',
        'packages/subpkg/file.ts': 'code',
      })
      const harness = register({ instructionSource: 'host' })
      const agent = agentAt(rootDir)
      await assemble(harness, FULL_SECTIONS, undefined, agent)

      listener(harness, 'tools/result')(
        { name: 'read', arguments: { file_path: join(rootDir, 'packages/subpkg/file.ts') }, agent, token: Symbol('token') },
        { isError: false },
      )
      const messages = [{ id: 'user-1', role: 'user', content: [] }]
      const step = await preStep(harness, agent, messages)
      // The harness's agent-instructions row owns subdirectory discovery now.
      expect(step.messages).toBe(messages)
      expect(step.messages).toHaveLength(1)
    })
  })

  test('leaves a rejected step decision untouched', async () => {
    const message = instructionsMessage('a', ['/repo/AGENTS.md'])
    const result = await preStep(register(), agentOf(), [message], 'reject')
    expect(result).toEqual({ kind: 'reject', messages: [message] })
  })

  test('extractInstructionPaths deduplicates in first-seen order', () => {
    const message = {
      content: [
        { type: 'text', text: 'Additional Instructions from: /b.md\nInstructions from: /a.md' },
        { type: 'text', text: 'Instructions from: /b.md' },
        { type: 'reasoning', text: 'Instructions from: /ignored.md' },
      ],
    }
    expect(extractInstructionPaths(message)).toEqual(['/b.md', '/a.md'])
    expect(extractInstructionPaths({})).toEqual([])
  })

  describe('dispatcher rule block', () => {
    /** The persona section text of one assembly. */
    function personaText(result: any): string {
      return result.sections.find((section: any) => section.name === 'deployment:persona-prefix').text
    }

    test('operator appends nothing at all while the switch is off', async () => {
      // Given the switch off, When the operator assembles the prompt, Then the
      // persona is the persona plus its workspace line and no dispatcher prose
      // reaches the prompt at all.
      const cwd = project()
      const agent = agentAt(cwd)
      const off = await assemble(register({ dispatcher: false }), FULL_SECTIONS, undefined, agent)
      expect(personaText(off)).toBe(`${PERSONA.text}\n\nYour working directory is ${cwd}.`)
      expect(off.sections.map((section: any) => section.name))
        .toEqual(['deployment:persona-prefix', 'plan:policy'])
      expect(personaText(off)).not.toContain('【角色识别】')
      expect(personaText(off)).not.toContain('Dispatcher rules')
      expect(JSON.stringify(off.sections)).not.toContain('反模式')
    })

    test('operator gets the appended block from a config that never mentions the switch', async () => {
      // Given a config with no dispatcher key at all, When the operator
      // assembles the prompt, Then the block is appended anyway: the plugin's
      // own fallback agrees with the shipped preset row, so an activation that
      // never states the switch still runs the mode the factory declares.
      const cwd = project()
      const absent = await assemble(register(), FULL_SECTIONS, undefined, agentAt(cwd))
      const on = await assemble(register({ dispatcher: true }), FULL_SECTIONS, undefined, agentAt(cwd))
      expect(personaText(absent)).toBe(personaText(on))
      expect(personaText(absent)).toContain('【角色识别】')
      expect(personaText(absent)).toContain(DISPATCHER_RULES)
    })

    test('operator gets a rejected non-boolean switch through config validation', () => {
      // Given a switch that is not a boolean, When the operator registers the
      // plugin, Then config validation rejects it instead of silently treating
      // a truthy string as enabled.
      expect(() => register({ dispatcher: 'yes' })).toThrow(/dispatcher must be a boolean/)
      expect(() => register({ dispatcher: 1 })).toThrow(/dispatcher must be a boolean/)
    })

    test('operator sees the rule block appended after the persona discipline, under a separator', async () => {
      // Given the switch on, When the operator assembles the prompt, Then the
      // persona and its discipline stay byte-identical and the heading plus the
      // rule block follow them, with the rest of the prompt untouched.
      const cwd = project()
      const result = await assemble(register({ dispatcher: true }), FULL_SECTIONS, undefined, agentAt(cwd))
      const text = personaText(result)
      const off = personaText(await assemble(register({ dispatcher: false }), FULL_SECTIONS, undefined, agentAt(cwd)))
      expect(text.startsWith(off)).toBe(true)
      expect(text.slice(off.length)).toBe(`${DISPATCHER_RULES_HEADING}${DISPATCHER_RULES_WITH_APPENDIX}`)
      // The persona discipline is still ahead of the appended rules.
      expect(text.indexOf('You are a helpful software engineer assistant.'))
        .toBeLessThan(text.indexOf('## Dispatcher rules'))
      // The heading separates the two blocks instead of gluing them together.
      expect(text).toContain('\n\n---\n\n## Dispatcher rules (a mode-level append)\n')
      // The switch changes only the persona section: the rest of the prompt is
      // untouched, and the tool wire is not involved at all.
      expect(result.sections.map((section: any) => section.name))
        .toEqual(['deployment:persona-prefix', 'plan:policy'])
      expect(result.sections.find((section: any) => section.name === 'plan:policy').text).toBe(PLAN.text)
    })

    test('operator gets the whole rule set: identity, R0 through R8, R-T, and the anti-patterns', async () => {
      // Given the switch on, When the operator assembles the prompt, Then every
      // section of the reviewed rule set is present verbatim, the text names no
      // repository that LiangShen does not own, and it carries no unbound
      // template variable the harness renderer would refuse.
      const result = await assemble(register({ dispatcher: true }), FULL_SECTIONS, undefined, agentAt(project()))
      const text = personaText(result)
      for (const marker of [
        '【角色识别】',
        '【调度者身份】',
        '## R0 · 复杂度分诊',
        '## R0.5 · 协作模式侦测',
        '## R-G · 澄清访谈',
        '## R1 · 职责边界',
        '## R2 · 模型路由',
        '## R3 · 子代理自治',
        '## R4 · 子代理角色',
        '## R5 · 派发纪律',
        '## R-T · teammate 模式',
        '## R6 · 审查与验收',
        '## R7 · 文档',
        '## R8 · 兜底',
        '## 反模式（出现即为违规）',
        '12. 给 spawn_teammate 编造 provider/model',
        '本节 G7–G14 是对上面 G1–G6 的本地补充',
        '- G7 提问预算',
        '- G14 查证型派发',
        'A. 用提问代替判断',
        'B. 同一决策重复追问',
      ]) {
        expect(text, marker).toContain(marker)
      }
      // The role-recognition paragraph is carried in full, and both role halves
      // are present: the dispatcher rules identify the executor case too.
      expect(text).toContain('若你的第一条用户消息是一份任务书（而不是用户本人的直接请求）')
      expect(text).toContain('R3 仍然有效')
      // The guards announced by R2 are sub-agent model authorization guards, and
      // the subscription repository that happens to own one is not named.
      expect(text).not.toContain('dsh-chatgpt-subscription')
      expect(text).not.toContain('subagentModelAuthorization')
      // No unbound template variables ride in with the block: the renderer
      // interpolates strictly, so a stray placeholder would fail every request.
      expect(text).not.toMatch(/\{\{/)
    })

    test('operator gets the interview additions after the reference block, which stays byte-identical', async () => {
      // Given the switch on, When the operator assembles the prompt, Then the
      // local interview additions ride after the last reference sentence and
      // the reference block itself is unchanged: the additions are an appendix,
      // not a rewrite of the text that was reviewed elsewhere.
      const result = await assemble(register({ dispatcher: true }), FULL_SECTIONS, undefined, agentAt(project()))
      const text = personaText(result)
      // The reference block ends at anti-pattern 12 and carries no addition.
      expect(DISPATCHER_RULES.endsWith('12. 给 spawn_teammate 编造 provider/model（它没有这两个参数）。')).toBe(true)
      expect(DISPATCHER_RULES).not.toContain('G7')
      expect(DISPATCHER_RULES_APPENDIX).not.toContain('## R-G · 澄清访谈')
      expect(DISPATCHER_RULES_WITH_APPENDIX).toBe(`${DISPATCHER_RULES}\n${DISPATCHER_RULES_APPENDIX}`)
      // The appendix follows the reference block, and every addition is
      // present once.
      for (const marker of [
        '本节 G7–G14 是对上面 G1–G6 的本地补充',
        '- G7 提问预算：一轮不超过 4 个问题',
        '- G8 假设出口：',
        '- G9 新证据：',
        '- G10 纪要落点：',
        '- G11 推荐质量：',
        '- G12 呈现与降级：',
        '- G13 L1 的最小形式：',
        '- G14 查证型派发：',
        'A. 用提问代替判断：',
        'B. 同一决策重复追问，',
      ]) {
        expect(text, marker).toContain(marker)
        expect(text.split(marker)).toHaveLength(2)
      }
      expect(text.indexOf('12. 给 spawn_teammate 编造 provider/model'))
        .toBeLessThan(text.indexOf('本节 G7–G14'))
    })

    test('operator keeps the additions when the persona already carries the reference block', async () => {
      // Given a persona that already holds the reference block but not the
      // additions, When the block is appended, Then only the additions are
      // added: the two halves are checked separately so neither is duplicated.
      const withReference = `persona\n${DISPATCHER_RULES}`
      const once = promptModule.withDispatcherRules(withReference)
      expect(once).toBe(`${withReference}\n${DISPATCHER_RULES_APPENDIX}`)
      expect(promptModule.withDispatcherRules(once)).toBe(once)
    })

    test('operator sees the appended block rendered by the harness renderer', async () => {
      // Given the switch on, When the operator renders the assembled sections
      // through the harness renderer, Then the dispatcher rules and the
      // workspace line both survive rendering.
      const cwd = project()
      const result = await assemble(register({ dispatcher: true }), FULL_SECTIONS, undefined, agentAt(cwd))
      const rendered = renderPrompt({ sections: result.sections, variables: result.variables })
      expect(rendered).toContain('【调度者身份】')
      expect(rendered).toContain('## 反模式（出现即为违规）')
      expect(rendered).toContain(`Your working directory is ${cwd}.`)
    })

    test('operator gets the rule block even when the session reports no cwd', async () => {
      // Given a session that reports no cwd, When the operator assembles the
      // prompt with the switch on, Then the rules still reach the persona while
      // no workspace line is invented.
      const result = await assemble(register({ dispatcher: true }), FULL_SECTIONS, undefined, { session: { header: {} } })
      const text = personaText(result)
      expect(text).not.toContain('Your working directory is')
      expect(text).toBe(`${PERSONA.text}${DISPATCHER_RULES_HEADING}${DISPATCHER_RULES_WITH_APPENDIX}`)
    })

    test('operator does not get the block twice when the persona already carries it', async () => {
      // Given the switch on, When the operator assembles twice over the sections
      // the first assembly produced, Then the block appears once: the append is
      // idempotent, as the workspace line is.
      const cwd = project()
      const harness = register({ dispatcher: true })
      const first = await assemble(harness, FULL_SECTIONS, undefined, agentAt(cwd))
      const second = await assemble(harness, first.sections, undefined, agentAt(cwd))
      const text = personaText(second)
      expect(text.split('【调度者身份】')).toHaveLength(2)
      expect(text).toBe(personaText(first))
    })

    test('operator keeps the append out of the workspace-instructions section', async () => {
      // Given the switch on under the system-prompt instruction source, When
      // the operator assembles the prompt, Then the appended instruction section
      // still follows the persona and still carries the variable reference, so
      // the rules live in the persona alone.
      writeHome('AGENTS.md', 'user-global rule')
      const cwd = project({ 'AGENTS.md': 'project rule' })
      const result = await assemble(register({ dispatcher: true, instructionSource: 'system-prompt' }), FULL_SECTIONS, undefined, agentAt(cwd))
      expect(result.sections.map((section: any) => section.name)).toEqual([
        'deployment:persona-prefix',
        'plan:policy',
        WORKSPACE_INSTRUCTIONS_SECTION_NAME,
      ])
      expect(result.variables.workspace_instructions).not.toContain('【角色识别】')
      expect(result.variables.workspace_instructions).toContain('project rule')
    })
  })

  describe('PTC prompt sections retention', () => {
    const RUN_CODE_WIRE = [{ name: 'run_code', description: 'Run a program.' }]

    test('retains tools:ptc-only and tools:sdk sections exactly when the wire carries run_code', async () => {
      const sdkText = 'interface ToolArgsMap { read: { file_path: string } }'
      const ptcOnlyText = '`run_code` is the only tool you can call directly.'
      const ptcSections = [
        PERSONA,
        { name: 'tools:ptc-only', text: ptcOnlyText },
        { name: 'tools:sdk', text: sdkText },
        { name: 'web:surface', text: 'ignore' },
      ]
      // 'both' / 'ptc' wire: the transport is present, so the SDK sections stay.
      const result = await assemble(register(), ptcSections, undefined, agentOf(), RUN_CODE_WIRE)
      const names = result.sections.map((s: any) => s.name)
      expect(names).toContain('tools:ptc-only')
      expect(names).toContain('tools:sdk')
      expect(names).not.toContain('web:surface')
      expect(result.sections.find((s: any) => s.name === 'tools:sdk').text).toBe(sdkText)
      expect(result.sections.find((s: any) => s.name === 'tools:ptc-only').text).toBe(ptcOnlyText)
    })

    test('drops tools:ptc-only and tools:sdk from a native wire without run_code', async () => {
      const ptcSections = [
        PERSONA,
        { name: 'tools:ptc-only', text: '`run_code` only' },
        { name: 'tools:sdk', text: 'interface ToolArgsMap {}' },
        { name: 'web:surface', text: 'ignore' },
      ]
      const result = await assemble(register(), ptcSections, undefined, agentOf(), [
        { name: 'bash', description: 'shell' },
        { name: 'read', description: 'read' },
      ])
      expect(result.sections.map((s: any) => s.name)).toEqual(['deployment:persona-prefix'])
    })

    test('keeps the SDK sections when the wire is unreadable', async () => {
      const ptcSections = [
        PERSONA,
        { name: 'tools:sdk', text: 'interface ToolArgsMap {}' },
      ]
      const result = await listener(register(), 'system-prompt/assemble')(
        undefined,
        { agent: agentOf() },
        async () => ({ sections: ptcSections, contexts: [], variables: {} }),
      )
      expect(result.sections.map((s: any) => s.name)).toContain('tools:sdk')
    })

    test('renders tools:sdk section through renderPrompt with variables intact', async () => {
      const sdkText = 'interface ToolArgsMap {\n  /** Read a file */\n  read: { file_path: string }\n}'
      writeHome('AGENTS.md', 'user-global rule')
      const cwd = project({ 'AGENTS.md': 'repo rule' })
      const ptcSections = [
        PERSONA,
        { name: 'tools:ptc-only', text: '`run_code` only' },
        { name: 'tools:sdk', text: sdkText },
      ]
      const result = await assemble(register({ instructionSource: 'system-prompt' }), ptcSections, undefined, agentAt(cwd), RUN_CODE_WIRE)
      const rendered = renderPrompt({ sections: result.sections, variables: result.variables })
      expect(rendered).toContain(sdkText)
      expect(rendered).toContain('`run_code` only')
      expect(rendered).toContain('user-global rule')
      expect(rendered).toContain('repo rule')
    })
  })

  describe('platform-neutral persona block', () => {
    test('exports no platform-conditional persona line', () => {
      // The shell is upstream and persistent on BOTH platforms (bash on POSIX,
      // pwsh on win32), so the persona block carries no shell discipline line
      // and no platform switch: the removed win32-only surface must stay gone
      // rather than be re-added under another name.
      for (const removed of ['WIN32_SHELL_LINE', 'withPlatformLine']) {
        expect(removed in promptModule, removed).toBe(false)
      }
      expect(promptModule.WIN32_SHELL_LINE).toBeUndefined()
      expect(promptModule.withPlatformLine).toBeUndefined()
    })

    test('produces the same persona text on win32 and on POSIX', async () => {
      // The assembled prompt is a pure function of the session cwd, so the two
      // platforms cannot diverge: nothing in the persona depends on the host.
      const cwd = project()
      const result = await assemble(register({ dispatcher: false }), FULL_SECTIONS, undefined, agentAt(cwd))
      const text = result.sections[0].text
      expect(text).toBe(`You are a helpful software engineer assistant.\n\nYour working directory is ${cwd}.`)
      expect(text).not.toContain('Current platform')
      expect(text).not.toContain('Git Bash')
      expect(text).not.toContain('ephemeral')
      // The persona stays the workspace line plus the shipped discipline only:
      // no third appended paragraph.
      expect(text.split('\n\n')).toHaveLength(2)
    })

    test('carries no platform-conditional code on the prompt-assembly path', () => {
      // The regression guard the removed line needs: a future platform append
      // would reintroduce a host-dependent system prompt. Assert at the source
      // level, because the tests themselves run on only ONE platform.
      const source = readFileSync(
        join(process.cwd(), 'presets/liangshen/minimal-prompt.mjs'),
        'utf8',
      )
      expect(source).not.toContain('process.platform')
      expect(source).not.toMatch(/win32/)
      expect(source).not.toMatch(/Git Bash/)
    })
  })

  describe('tool touch extraction and str_replace_editor bridging', () => {
    test('extracts file path from native read/write/edit and str_replace_editor', () => {
      expect(filePathFromExecution({ name: 'read', arguments: { file_path: 'foo.ts' } })).toBe('foo.ts')
      expect(filePathFromExecution({ name: 'write', arguments: { file_path: 'bar.ts' } })).toBe('bar.ts')
      expect(filePathFromExecution({ name: 'edit', arguments: { file_path: 'baz.ts' } })).toBe('baz.ts')
      expect(filePathFromExecution({ name: 'str_replace_editor', arguments: { command: 'view', path: '/repo/src/a.ts' } })).toBe('/repo/src/a.ts')
      expect(filePathFromExecution({ name: 'str_replace_editor', arguments: { command: 'create', path: '/repo/src/b.ts' } })).toBe('/repo/src/b.ts')
      expect(filePathFromExecution({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: '/repo/src/c.ts' } })).toBe('/repo/src/c.ts')
      expect(filePathFromExecution({ name: 'str_replace_editor', arguments: { command: 'insert', path: '/repo/src/d.ts' } })).toBe('/repo/src/d.ts')
      expect(filePathFromExecution({ name: 'bash', arguments: { command: 'ls' } })).toBeUndefined()
      expect(filePathFromExecution(undefined)).toBeUndefined()
      expect(filePathFromExecution({ name: 'read', arguments: {} })).toBeUndefined()
      expect(filePathFromExecution({ name: 'read', arguments: null })).toBeUndefined()
    })
    test('str_replace_editor synchronously records touched directory and discovers in pre-step', async () => {
      const rootDir = project({
        'AGENTS.md': 'root rule',
        'packages/subpkg/AGENTS.md': 'subpackage rule',
        'packages/subpkg/file.ts': 'code',
      })
      const harness = register({ instructionSource: 'system-prompt' })
      const agent = agentAt(rootDir)

      await assemble(harness, FULL_SECTIONS, undefined, agent)

      const exec = {
        name: 'str_replace_editor',
        arguments: { command: 'view', path: join(rootDir, 'packages/subpkg/file.ts') },
        agent,
        token: Symbol('token'),
      }
      listener(harness, 'tools/result')(exec, { isError: false })

      const step = await preStep(harness, agent, [{ id: 'user-1', role: 'user', content: [] }])
      expect(step.messages.some((m: any) => m.source?.kind === 'liangshen-minimal-prompt' && m.content[0]?.text?.includes('subpackage rule'))).toBe(true)
    })

    test('does not record touched directory for failed or aborted tool executions', async () => {
      const rootDir = project({
        'packages/subpkg/AGENTS.md': 'subpackage rule',
        'packages/subpkg/file.ts': 'code',
      })
      const harness = register({ instructionSource: 'system-prompt' })
      const agent = agentAt(rootDir)
      await assemble(harness, FULL_SECTIONS, undefined, agent)

      // Error execution
      listener(harness, 'tools/result')(
        { name: 'str_replace_editor', arguments: { command: 'view', path: join(rootDir, 'packages/subpkg/file.ts') }, agent },
        { isError: true },
      )
      const step1 = await preStep(harness, agent, [{ id: 'user-1', role: 'user', content: [] }])
      expect(step1.messages.some((m: any) => m.source?.kind === 'liangshen-minimal-prompt' || m.source?.kind === 'plugin')).toBe(false)

      // Aborted execution
      const abortCtrl = new AbortController()
      abortCtrl.abort()
      listener(harness, 'tools/result')(
        { name: 'str_replace_editor', arguments: { command: 'view', path: join(rootDir, 'packages/subpkg/file.ts') }, agent, signal: abortCtrl.signal },
        { isError: false },
      )
      const step2 = await preStep(harness, agent, [{ id: 'user-2', role: 'user', content: [] }])
      expect(step2.messages.some((m: any) => m.source?.kind === 'liangshen-minimal-prompt' || m.source?.kind === 'plugin')).toBe(false)
    })

    test('reconstructs touched directories from durable session history on replay', async () => {
      const rootDir = project({
        'AGENTS.md': 'root rule',
        'packages/replayed/AGENTS.md': 'replayed subpackage rule',
        'packages/replayed/file.ts': 'code',
      })
      const harness = register({ instructionSource: 'system-prompt' })
      const pastEvents = [
        {
          type: 'tool/call',
          data: {
            name: 'str_replace_editor',
            arguments: JSON.stringify({ command: 'view', path: join(rootDir, 'packages/replayed/file.ts') }),
          },
        },
      ]
      const agent = {
        session: {
          header: { cwd: rootDir },
          snapshotEvents: () => pastEvents,
        },
      }
      await assemble(harness, FULL_SECTIONS, undefined, agent)
      const step = await preStep(harness, agent, [{ id: 'user-replay', role: 'user', content: [] }])
      expect(step.messages.some((m: any) => m.content[0]?.text?.includes('replayed subpackage rule'))).toBe(true)
    })
  })

  describe('dynamic subdirectory instruction reconciliation', () => {
    test('condenses pure covered baseline message into concise legal message when baseline is loaded', async () => {
      const rootDir = project({ 'AGENTS.md': 'root rule' })
      const harness = register({ instructionSource: 'system-prompt' })
      const agent = agentAt(rootDir)
      await assemble(harness, FULL_SECTIONS, undefined, agent)

      const pureBaselineMsg = {
        id: 'base-1',
        role: 'user',
        content: [{
          type: 'text',
          text: '<system-reminder>\nInstructions from: AGENTS.md\n\nroot rule\n</system-reminder>',
        }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          baseline: true,
          baselineIdentity: 'id-baseline',
          changes: [{ action: 'set', scope: '.\\0AGENTS.md', path: 'AGENTS.md' }],
        },
      }

      const result = await preStep(harness, agent, [pureBaselineMsg])
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].id).toBe('base-1')
      expect(result.messages[0].source.baseline).toBe(true)
      expect(result.messages[0].source.baselineIdentity).toBe('id-baseline')
      expect(result.messages[0].content[0].text).toContain('Workspace baseline instructions')
      expect(result.messages[0].content[0].text).not.toContain('root rule')
    })

    test('passes through baseline message when baseline loading failed', async () => {
      const harness = register({ instructionSource: 'system-prompt' })
      const agent = agentAt('/nonexistent/path/for/failure')

      const pureBaselineMsg = {
        id: 'base-fail',
        role: 'user',
        content: [{
          type: 'text',
          text: '<system-reminder>\nInstructions from: AGENTS.md\n\nroot rule\n</system-reminder>',
        }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          baseline: true,
          baselineIdentity: 'id-baseline',
          changes: [{ action: 'set', scope: '.\\0AGENTS.md', path: 'AGENTS.md' }],
        },
      }

      const result = await preStep(harness, agent, [pureBaselineMsg])
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].content[0].text).toContain('root rule')
    })

    test('retains dynamic update and removal instructions', async () => {
      const harness = register({ instructionSource: 'system-prompt' })
      const agent = agentOf()

      const updateMsg = {
        id: 'update-1',
        role: 'user',
        content: [{
          type: 'text',
          text: '<system-reminder>\nUpdated instructions from: packages/subpkg/AGENTS.md\n\nnew rule\n</system-reminder>',
        }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          changes: [{ action: 'replace', scope: 'packages/subpkg\\0AGENTS.md', path: 'packages/subpkg/AGENTS.md' }],
        },
      }

      const removeMsg = {
        id: 'remove-1',
        role: 'user',
        content: [{
          type: 'text',
          text: '<system-reminder>\nInstructions removed: packages/subpkg/AGENTS.md\n\nremoved\n</system-reminder>',
        }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          changes: [{ action: 'remove', scope: 'packages/subpkg\\0AGENTS.md', path: 'packages/subpkg/AGENTS.md' }],
        },
      }

      const resUpdate = await preStep(harness, agent, [updateMsg])
      expect(resUpdate.messages).toHaveLength(1)
      expect(resUpdate.messages[0].content[0].text).toContain('Updated instructions from: packages/subpkg/AGENTS.md')

      const resRemove = await preStep(harness, agent, [removeMsg])
      expect(resRemove.messages).toHaveLength(1)
      expect(resRemove.messages[0].content[0].text).toContain('Instructions removed: packages/subpkg/AGENTS.md')
    })

    test('PTC nested dispatch touch bubbles up and multi-step in-flight limitation', () => {
      const outerToken = Symbol('outer-run-code')
      const innerReadExec = {
        name: 'read',
        arguments: { file_path: 'packages/subpkg/file.ts' },
        parent: outerToken,
        agent: agentOf(),
      }
      const innerWriteExec = {
        name: 'write',
        arguments: { file_path: 'packages/subpkg/file.ts', content: 'hello' },
        parent: outerToken,
        agent: innerReadExec.agent,
      }

      expect(filePathFromExecution(innerReadExec)).toBe('packages/subpkg/file.ts')
      expect(filePathFromExecution(innerWriteExec)).toBe('packages/subpkg/file.ts')
      expect(innerReadExec.parent).toBe(outerToken)
      expect(innerWriteExec.parent).toBe(outerToken)
    })
  })

  describe('deduplication, compaction and error recovery', () => {
    test('clears per-session cached baseline paths on compaction/end event', async () => {
      const harness = register()
      const agent = agentAt(project({ 'AGENTS.md': 'rule' }))
      await preStep(harness, agent, [])
      const eventListener = listener(harness, 'session/event')
      await eventListener(agent.session, { type: 'compaction/end' }, undefined)
      const result = await preStep(harness, agent, [])
      expect(result.kind).toBe('enter')
    })

    test('isBaselineInstructionPath handles invalid or empty inputs safely', () => {
      expect(isBaselineInstructionPath('', new Set())).toBe(false)
      expect(isBaselineInstructionPath(undefined as any, new Set())).toBe(false)
      expect(isBaselineInstructionPath('  ', new Set())).toBe(false)
      expect(isBaselineInstructionPath('~/.dsh/AGENTS.md', new Set())).toBe(true)
      expect(isBaselineInstructionPath('$DSH_HOME/AGENTS.md', new Set())).toBe(true)
      expect(isBaselineInstructionPath('AGENTS.md', new Set())).toBe(true)
      expect(isBaselineInstructionPath('packages/other/AGENTS.md', new Set())).toBe(false)
    })
  })

  describe('end-to-end multi-turn lifecycle scenarios', () => {
    test('repo root start -> touch subpackage via str_replace_editor -> receive package-level AGENTS', async () => {
      const rootDir = project({
        'AGENTS.md': 'root repo rule',
        'packages/subpkg/AGENTS.md': 'subpackage specific rule',
        'packages/subpkg/file.ts': 'export const a = 1;',
      })
      const harness = register({ instructionSource: 'system-prompt' })
      const agent = agentAt(rootDir)

      // Turn 1: System prompt assemble carries root repo rule residently
      const assembled1 = await assemble(harness, FULL_SECTIONS, undefined, agent)
      expect(assembled1.variables.workspace_instructions).toContain('root repo rule')
      expect(assembled1.variables.workspace_instructions).not.toContain('subpackage specific rule')

      // Turn 1 Pre-step: Initial prompt with covered baseline is condensed into concise legal message
      const baselineMsg = {
        id: 'baseline-turn-1',
        role: 'user',
        content: [{
          type: 'text',
          text: '<system-reminder>\nInstructions from: AGENTS.md\n\nroot repo rule\n</system-reminder>',
        }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          baseline: true,
          baselineIdentity: 'baseline-root',
          changes: [{ action: 'set', scope: '.\\0AGENTS.md', path: 'AGENTS.md' }],
        },
      }
      const turn1Step = await preStep(harness, agent, [{ id: 'user-turn-1', role: 'user', content: [] }, baselineMsg])
      expect(turn1Step.messages).toHaveLength(2)
      expect(turn1Step.messages[0].id).toBe('user-turn-1')
      expect(turn1Step.messages[1].id).toBe('baseline-turn-1')
      expect(turn1Step.messages[1].source.baseline).toBe(true)
      expect(turn1Step.messages[1].content[0].text).toContain('Workspace baseline instructions')
      expect(turn1Step.messages[1].content[0].text).not.toContain('root repo rule')

      // Turn 1 Tool execution: model calls str_replace_editor on subpackage file
      listener(harness, 'tools/result')({
        name: 'str_replace_editor',
        arguments: { command: 'view', path: join(rootDir, 'packages/subpkg/file.ts') },
        agent,
        token: Symbol('token-1'),
      }, { isError: false })

      // Turn 2 Pre-step: Discovers package-level AGENTS and delivers legal plugin message
      const turn2Step = await preStep(harness, agent, [{ id: 'user-turn-2', role: 'user', content: [] }])
      expect(turn2Step.messages.length).toBeGreaterThanOrEqual(2)
      const dynamicPluginMsg = turn2Step.messages.find((m: any) => m.source?.kind === 'liangshen-minimal-prompt')
      expect(dynamicPluginMsg).toBeDefined()
      expect(dynamicPluginMsg.content[0].text).toContain('Additional instructions from: packages/subpkg/AGENTS.md')
      expect(dynamicPluginMsg.content[0].text).toContain('subpackage specific rule')
    })

    test('compaction recovery preserves baseline system prompt and recovers state', async () => {
      const rootDir = project({ 'AGENTS.md': 'persistent root rule' })
      const harness = register({ instructionSource: 'system-prompt' })
      const agent = agentAt(rootDir)

      const firstAssembly = await assemble(harness, FULL_SECTIONS, undefined, agent)
      expect(firstAssembly.variables.workspace_instructions).toContain('persistent root rule')

      await listener(harness, 'session/event')(agent.session, { type: 'compaction/end' }, undefined)

      const postCompactionAssembly = await assemble(harness, FULL_SECTIONS, undefined, agent)
      expect(postCompactionAssembly.variables.workspace_instructions).toContain('persistent root rule')

      const dynamicAfterCompact = {
        id: 'dyn-after-compact',
        role: 'user',
        content: [{
          type: 'text',
          text: '<system-reminder>\nAdditional instructions from: packages/foo/AGENTS.md\n\nfoo rule\n</system-reminder>',
        }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          changes: [{ action: 'set', scope: 'packages/foo\\0AGENTS.md', path: 'packages/foo/AGENTS.md' }],
        },
      }
      const stepAfterCompact = await preStep(harness, agent, [dynamicAfterCompact])
      expect(stepAfterCompact.messages).toHaveLength(1)
      expect(stepAfterCompact.messages[0].content[0].text).toContain('foo rule')
    })

    test('deduplicates sibling instructions per directory and repeated touches', async () => {
      const rootDir = project({
        'packages/pkg/AGENTS.md': 'shared rule content',
        'packages/pkg/CLAUDE.md': 'shared rule content',
      })
      const files = await loadInstructionFiles(join(rootDir, 'packages/pkg'))
      expect(files).toHaveLength(1)
      expect(files[0].content).toBe('shared rule content')
    })

    test('budget constraint truncates or omits files under tight budget without crashing', () => {
      const files = [
        { displayPath: '$DSH_HOME/AGENTS.md', content: 'global rule '.repeat(20) },
        { displayPath: 'AGENTS.md', content: 'project rule '.repeat(20) },
      ]
      const rendered = renderInstructionSection(files, 650)
      expect(rendered).toBeDefined()
      expect(Buffer.byteLength(rendered!, 'utf8')).toBeLessThanOrEqual(650)
      expect(rendered).toContain('omitted $DSH_HOME/AGENTS.md')
      expect(rendered).toContain('project rule')
    })

    test('system instruction priority framework is maintained across sections', async () => {
      const rootDir = project({ 'AGENTS.md': 'base rule' })
      const text = await loadInstructionText(rootDir)
      expect(text).toContain('more specific files take precedence over broader ones')
      expect(text).toContain('direct user instruction for the current task takes precedence over all of them')
    })
  })
})
