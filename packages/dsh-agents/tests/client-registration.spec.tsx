// @vitest-environment jsdom
/**
 * Registration contract of the agents sub-plugin.
 *
 * The page is an official center-column panel: one row in the sidebar shell's
 * global panel list and one keyed `main` occupant. These cases drive the real
 * registration over a capture context, so a regression that hand-draws a
 * sidebar row, reuses another package's panel id, or freezes the row label at
 * module scope fails here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { AGENTS_PANEL_ID, AgentsPanelIcon, registerAgentsPanel } from '../src/client/panel.tsx'
import { en, registerAgentLocales, setRuntimeTranslate, t, zh } from '../src/client/locales.ts'
import type { LocaleRegistrar } from '../src/client/locales.ts'
import { createAgentsTransport } from '../src/client/host-api.ts'
import { mount, unmountAll } from './render.tsx'

/** What one registration call landed in the capture context. */
interface Capture {
  injected: string[]
  registrations: Array<{ options: Record<string, unknown>; component: unknown }>
  released: number
}

/** A client context whose slot service records instead of rendering. */
function captureContext(): { ctx: { slots: unknown }; capture: Capture } {
  const capture: Capture = { injected: [], registrations: [], released: 0 }
  return {
    ctx: {
      slots: {
        inject(key: string, callback: () => () => void): () => void {
          capture.injected.push(key)
          return callback()
        },
        register(options: Record<string, unknown>, component: unknown): () => void {
          capture.registrations.push({ options, component })
          return () => { capture.released += 1 }
        },
      },
    },
    capture,
  }
}

const transport = createAgentsTransport()

afterEach(() => {
  setRuntimeTranslate(undefined)
  unmountAll()
})

describe('agents panel registration', () => {
  it('operator sees the sidebar row contributed to the shell panel list, not drawn by the plugin', () => {
    // Given a shell that declares both seats
    const { ctx, capture } = captureContext()
    // When the plugin registers itself
    registerAgentsPanel(ctx as never, transport)
    // Then the row is a list entry with the shell's required options
    expect(capture.injected).toEqual(['sidebar.panellist', 'main'])
    const row = capture.registrations[0].options
    expect(row.name).toBe('sidebar.panellist')
    expect(row.id).toBe(AGENTS_PANEL_ID)
    expect(row.order).toBe(30)
    expect(typeof row.label).toBe('function')
  })

  it('operator sees the page contributed as the keyed main occupant of the same id', () => {
    // Given the capture context
    const { ctx, capture } = captureContext()
    // When the plugin registers itself
    registerAgentsPanel(ctx as never, transport)
    // Then the page is addressed by the row id, so selecting the row shows it
    const page = capture.registrations[1].options
    expect(page.name).toBe('main')
    expect(page.key).toBe(AGENTS_PANEL_ID)
    expect(capture.registrations[1].component).toBeTypeOf('function')
  })

  it('operator sees the sidebar label follow a language switch without a reload', () => {
    // Given a shell whose translate seat follows the active language
    const { ctx, capture } = captureContext()
    registerAgentsPanel(ctx as never, transport)
    let lang: 'zh' | 'en' = 'zh'
    setRuntimeTranslate((key: keyof typeof zh) => (lang === 'en' ? en : zh)[key])
    const label = capture.registrations[0].options.label as () => string
    // When the language changes between two resolutions
    const chinese = label()
    lang = 'en'
    const english = label()
    // Then the same thunk answers the new language, which is what makes the
    // shell's existing row re-render
    expect(chinese).toBe(zh['entry.label'])
    expect(english).toBe(en['entry.label'])
  })

  it('operator sees unmount release both seats', () => {
    // Given one registration
    const { ctx, capture } = captureContext()
    const dispose = registerAgentsPanel(ctx as never, transport)
    // When the plugin unloads
    dispose()
    // Then both registrations are released, so a reload can claim them again
    expect(capture.released).toBe(2)
  })

  it('operator sees the row glyph supply only an icon, never a label or a button', () => {
    // Given the row component the shell renders inside its own button
    // When the glyph mounts
    const view = mount(<AgentsPanelIcon size={18} active={false} />)
    // Then it draws one decorative svg carrying the panel anchor
    const glyph = view.container.querySelector('[data-dsh-panel-entry="' + AGENTS_PANEL_ID + '"]')
    expect(glyph?.tagName.toLowerCase()).toBe('svg')
    expect(glyph?.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('button')).toBeNull()
  })
})

describe('agents entry services', () => {
  it('operator sees the entry wait for the locale service before it applies', () => {
    // Given the browser entry module
    // When its required-service list is read
    // Then it asks cordis for the slot and locale seats together, so a slow
    // locale seat pends the apply instead of letting the page paint raw keys
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('operator sees the entry still mount when the deployment serves no locale seat', () => {
    // Given a context whose locale accessor throws the way cordis does for a
    // service the caller did not inject, and a slot service that records
    const { ctx, capture } = captureContext()
    const withoutLocale = {
      ...ctx,
      get locale(): never { throw new Error('cannot get locale without inject') },
      effect(execute: () => () => void): () => void { return execute() },
    }
    // When the plugin applies
    // Then the absent seat degrades instead of failing boot...
    expect(() => { apply(withoutLocale as never) }).not.toThrow()
    // ...and both seats are still registered
    expect(capture.injected).toEqual(['sidebar.panellist', 'main'])
    expect(capture.released).toBe(0)
  })
})

describe('agents dictionaries', () => {
  it('operator sees the zh and en dictionaries registered under one namespace', () => {
    // Given a locale service that records registrations
    const registered: string[] = []
    let releaseDictionary = 0
    const locale: LocaleRegistrar = {
      register(namespace: string, dictionaries: { zh: typeof zh; en: typeof en }): () => void {
        registered.push(namespace)
        expect(Object.keys(dictionaries.en)).toEqual(Object.keys(dictionaries.zh))
        return () => { releaseDictionary += 1 }
      },
      bind(): (key: keyof typeof zh, params?: Record<string, string>) => string {
        return (key: keyof typeof zh) => zh[key]
      },
    }
    // When the entry wires the dictionaries
    const dispose = registerAgentLocales({ locale })
    // Then the page reads its copy through the bound seat, and unmounting
    // restores the document-language fallback
    expect(registered).toEqual(['dsh-agents'])
    expect(t('entry.label')).toBe(zh['entry.label'])
    dispose()
    expect(releaseDictionary).toBe(1)
  })
})
