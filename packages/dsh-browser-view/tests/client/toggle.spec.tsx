// @vitest-environment jsdom
/**
 * Header shortcut: it must reveal the browser-view tab through the sidebar face
 * ("focus the one this session has, open one only when it has none") and keep
 * its copy in the active language, without claiming a pressed state the
 * shell's tab strip owns.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserViewToggle } from '../../src/client/toggle.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { BrowserViewSidebarTabs } from '../../src/client/sidebar-tabs.ts'
import { actOn, render, type RenderedTree } from './render.tsx'
import { translate } from './translate.ts'

/** Mounted tree shared by one case. */
let tree: RenderedTree | null = null

afterEach(() => {
  tree?.unmount()
  tree = null
  document.body.innerHTML = ''
})

/** Find the shortcut button in a mounted container. */
function toggleButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('[data-dsh-part="toggle"]')
  if (button === null) throw new Error('toggle button not rendered')
  return button as HTMLButtonElement
}

/** Recording sidebar face: what the shortcut asked the column to reveal. */
function createRecordingTabs(): { readonly face: BrowserViewSidebarTabs; readonly asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    face: {
      ensureOpen(sessionId: string): void {
        asked.push(sessionId)
      },
    },
  }
}

describe('browser view header shortcut', () => {
  it('user clicks the header shortcut and the sidebar is asked to reveal that session tab', () => {
    // Given the shortcut mounted for one session with a recording sidebar face
    // When the user clicks it
    // Then the face is asked for that session exactly once and the button names what it does
    const tabs = createRecordingTabs()
    const mounted = render(<BrowserViewToggle t={translate(zh)} tabs={tabs.face} sessionId="session-a" />)
    tree = mounted

    const button = toggleButton(mounted.container)
    expect(button.getAttribute('data-dsh-plugin')).toBe('browser-view')
    expect(button.getAttribute('aria-label')).toBe(zh['toggle.open'])

    actOn(() => { button.click() })

    expect(tabs.asked).toEqual(['session-a'])
    expect(mounted.container.textContent).toContain(zh['toggle.label'])
  })

  it('user switches language and the shortcut carries the new copy with no pressed state', () => {
    // Given the shortcut mounted with the Chinese dictionary
    // When it re-renders with the English dictionary
    // Then the English copy replaces the Chinese one and the button declares no pressed state
    const tabs = createRecordingTabs()
    const mounted = render(<BrowserViewToggle t={translate(zh)} tabs={tabs.face} sessionId="session-a" />)
    tree = mounted
    expect(toggleButton(mounted.container).getAttribute('aria-pressed')).toBeNull()

    mounted.rerender(<BrowserViewToggle t={translate(en)} tabs={tabs.face} sessionId="session-a" />)

    expect(toggleButton(mounted.container).getAttribute('aria-label')).toBe(en['toggle.open'])
    expect(mounted.container.textContent).toContain(en['toggle.label'])
    expect(mounted.container.textContent).not.toContain(zh['toggle.label'])
  })

  it('operator loads a shell that injects no sidebar face and the shortcut still renders and clicks safely', () => {
    // Given the shortcut mounted without a sidebar face, as a shell whose column services are absent would render it
    // When the user clicks it
    // Then the button is still there and the click neither throws nor records anything
    const tabs = createRecordingTabs()
    const mounted = render(<BrowserViewToggle t={translate(zh)} />)
    tree = mounted

    actOn(() => { toggleButton(mounted.container).click() })

    expect(tabs.asked).toEqual([])
    expect(mounted.container.querySelectorAll('[data-dsh-part="toggle"]')).toHaveLength(1)
  })
})
