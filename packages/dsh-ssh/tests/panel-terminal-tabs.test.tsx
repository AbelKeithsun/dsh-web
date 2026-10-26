// @vitest-environment jsdom
/**
 * TerminalTab multi-tab behaviour: every tab is a client-side view over its own
 * host-side PTY session (the controller owns the list, the host keeps the
 * session alive). These tests pin the three contracts the tab strip relies on:
 * a second connect opens a second tab (the previous shell is detached, not
 * closed), focusing a background tab reattaches its session id, and closing a
 * tab ends its host session (through the live socket or a short-lived one).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { TerminalTab } from '../src/client/panel/TerminalTab.tsx'
import { PanelController } from '../src/client/panel/controller.ts'
import type { SshApi, TerminalConnection } from '../src/client/api.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  window.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList
}

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

/** One fake terminal socket with observable lifecycle calls. */
type FakeConnection = Omit<TerminalConnection, 'detach' | 'close'> & {
  detach: Mock
  close: Mock
}

function fakeConnection(): FakeConnection {
  return {
    onReady: undefined,
    onOutput: undefined,
    onExit: undefined,
    onAuthPrompt: undefined,
    send: vi.fn(),
    resize: vi.fn(),
    sendAuthResponse: vi.fn(),
    detach: vi.fn(),
    close: vi.fn(),
  }
}

/** Host list plus the sockets each entry point handed out. */
function fakeApi(): {
  api: SshApi
  opened: Array<{ alias: string; connection: FakeConnection }>
  attached: Array<{ sessionId: string; connection: FakeConnection }>
} {
  const opened: Array<{ alias: string; connection: FakeConnection }> = []
  const attached: Array<{ sessionId: string; connection: FakeConnection }> = []
  return {
    opened,
    attached,
    api: {
      listHosts: vi.fn(async () => [
        { alias: 'alpha', host: 'alpha.test', port: 22, user: 'u', auth: 'password', tags: [], proxyJump: [] },
        { alias: 'beta', host: 'beta.test', port: 22, user: 'u', auth: 'password', tags: [], proxyJump: [] },
      ]),
      openTerminal: vi.fn((alias: string) => {
        const connection = fakeConnection()
        opened.push({ alias, connection })
        return connection
      }),
      attachTerminal: vi.fn((sessionId: string) => {
        const connection = fakeConnection()
        attached.push({ sessionId, connection })
        return connection
      }),
    } as unknown as SshApi,
  }
}

/** Mount the terminal tab and flush its first effects. */
async function mount(api: SshApi, controller: PanelController): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<TerminalTab api={api} controller={controller} presetAlias="alpha" />) })
  await act(async () => { await Promise.resolve() })
  return { container, root }
}

/** The tab strip's tab buttons (the panel's own tab bar is not mounted here). */
function tabButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')]
}

/** Select another alias in the host dropdown. */
async function selectAlias(container: HTMLElement, alias: string): Promise<void> {
  const select = container.querySelector('select') as HTMLSelectElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, alias)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Click the Connect control (the first button in the controls row). */
async function clickConnect(container: HTMLElement): Promise<void> {
  const connect = container.querySelectorAll<HTMLButtonElement>('button')[0]!
  await act(async () => { connect.click() })
  await act(async () => { await Promise.resolve() })
}

describe('TerminalTab multi-tab', () => {
  it('opens a second tab for a second connect and detaches the first shell', async () => {
    const { api, opened } = fakeApi()
    const controller = new PanelController()
    const { container } = await mount(api, controller)

    await clickConnect(container)
    expect(opened.map(entry => entry.alias)).toEqual(['alpha'])
    expect(tabButtons(container)).toHaveLength(1)

    // A ready frame records the host session on ITS tab.
    await act(async () => { opened[0]!.connection.onReady?.('session-alpha', 'alpha') })
    expect(controller.getSnapshot().terminalTabs[0]?.sessionId).toBe('session-alpha')

    await selectAlias(container, 'beta')
    await clickConnect(container)
    expect(opened.map(entry => entry.alias)).toEqual(['alpha', 'beta'])
    // Two tabs, one focused: the alpha shell is detached (host keeps it) and
    // the view now belongs to the beta socket.
    await act(async () => { opened[1]!.connection.onReady?.('session-beta', 'beta') })
    const { terminalTabs, activeTerminalKey } = controller.getSnapshot()
    expect(terminalTabs).toHaveLength(2)
    expect(terminalTabs.map(tab => tab.alias)).toEqual(['alpha', 'beta'])
    expect(terminalTabs[1]?.key).toBe(activeTerminalKey)
    expect(opened[0]!.connection.detach).toHaveBeenCalled()
    expect(opened[0]!.connection.close).not.toHaveBeenCalled()
    expect(tabButtons(container)).toHaveLength(2)
  })

  it('reattaches a background tab by its host session id', async () => {
    const { api, opened, attached } = fakeApi()
    const controller = new PanelController()
    const { container } = await mount(api, controller)

    await clickConnect(container)
    await act(async () => { opened[0]!.connection.onReady?.('session-alpha', 'alpha') })
    await selectAlias(container, 'beta')
    await clickConnect(container)
    await act(async () => { opened[1]!.connection.onReady?.('session-beta', 'beta') })

    // Focus the alpha tab again: the beta socket detaches, alpha reattaches.
    const alphaTab = tabButtons(container).find(button => button.textContent === 'alpha')!
    await act(async () => { alphaTab.click() })
    await act(async () => { await Promise.resolve() })
    expect(attached.map(entry => entry.sessionId)).toEqual(['session-alpha'])
    expect(opened[1]!.connection.detach).toHaveBeenCalled()
    expect(opened[1]!.connection.close).not.toHaveBeenCalled()
  })

  it('ends the focused tab host session with a close frame', async () => {
    const { api, opened } = fakeApi()
    const controller = new PanelController()
    const { container } = await mount(api, controller)

    await clickConnect(container)
    await act(async () => { opened[0]!.connection.onReady?.('session-alpha', 'alpha') })

    const closeButton = tabButtons(container)[0]!.nextElementSibling as HTMLButtonElement
    await act(async () => { closeButton.click() })
    expect(opened[0]!.connection.close).toHaveBeenCalled()
    expect(controller.getSnapshot().terminalTabs).toHaveLength(0)
    expect(tabButtons(container)).toHaveLength(0)
  })

  it('ends a background tab host session through a short-lived attach', async () => {
    const { api, opened, attached } = fakeApi()
    const controller = new PanelController()
    const { container } = await mount(api, controller)

    await clickConnect(container)
    await act(async () => { opened[0]!.connection.onReady?.('session-alpha', 'alpha') })
    await selectAlias(container, 'beta')
    await clickConnect(container)
    await act(async () => { opened[1]!.connection.onReady?.('session-beta', 'beta') })

    // Close the background (alpha) tab: no live socket, so a transient attach
    // sends the close frame once the host acknowledges the reattach.
    const alphaClose = tabButtons(container).find(button => button.textContent === 'alpha')!.nextElementSibling as HTMLButtonElement
    await act(async () => { alphaClose.click() })
    expect(attached.map(entry => entry.sessionId)).toEqual(['session-alpha'])
    await act(async () => { attached[0]!.connection.onReady?.('session-alpha', 'alpha') })
    expect(attached[0]!.connection.close).toHaveBeenCalled()
    expect(controller.getSnapshot().terminalTabs.map(tab => tab.alias)).toEqual(['beta'])
    // The live beta socket is untouched.
    expect(opened[1]!.connection.close).not.toHaveBeenCalled()
    expect(opened[1]!.connection.detach).not.toHaveBeenCalled()
  })
})
