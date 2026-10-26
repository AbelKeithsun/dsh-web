/**
 * Terminal tab: an xterm.js PTY view over the host's WebSocket terminal route.
 *
 * Multi-tab: the tab list (with each tab's host session id) lives in the panel
 * controller, so switching tabs, closing the panel or unmounting the page never
 * loses a shell. The host keeps every PTY session alive (`engine/terminal-
 * sessions.ts`); this view owns exactly one xterm at a time and reattaches the
 * focused tab by session id, which replays the host-side scrollback. That keeps
 * the DOM footprint of N tabs at one terminal instead of N.
 *
 * A host <select> plus connect/disconnect controls; the terminal container is
 * sized by FitAddon (default 80x24 before first fit). On remote exit the last
 * output stays visible and input is disabled. xterm's stylesheet is injected
 * once per page load (module-level guard).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SshApi, TerminalConnection } from '../api.ts'
import type { SshHostSummary } from '../../protocol.ts'
import type { PanelController, TerminalTabState } from './controller.ts'
import { XTERM_CSS } from './xterm.css.ts'
import { errorMessage, resolveTerminalFontFamily, tt, type TerminalFontSource } from './helpers.ts'
import css from './panel.module.css'

/** Terminal tab props. */
export interface TerminalTabProps {
  api: SshApi
  /** The panel controller that owns the terminal tabs and their session ids. */
  controller: PanelController
  /** Alias preselected by a hosts-tab "connect" action. */
  presetAlias?: string
  /**
   * Live terminal-font setting source (issue #577). Absent in tests and
   * legacy mounts: the font then comes from the CSS custom-property chain.
   */
  terminalFont?: TerminalFontSource
}

/** The terminal session lifecycle state shown in the status banner. */
type TerminalStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; alias: string }
  | { kind: 'exited'; alias: string; detail?: string }
  | { kind: 'error'; detail: string }

/** In-flight 2FA challenge prompts. */
interface AuthPromptState {
  name: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
}

/** Injected-once guard for the xterm stylesheet (one tag per page load). */
let xtermCssInjected = false

function ensureXtermCss(): void {
  if (xtermCssInjected || typeof document === 'undefined') return
  xtermCssInjected = true
  if (document.querySelector('style[data-dsh-ssh-xterm]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshSshXterm = ''
  style.textContent = XTERM_CSS
  document.head.appendChild(style)
}

/** No-op source stand-in so the hook order stays stable without the prop. */
const NO_FONT_SOURCE: TerminalFontSource = {
  get: () => undefined,
  subscribe: () => () => undefined,
}

/** The xterm terminal view. */
export function TerminalTab({ api, controller, presetAlias, terminalFont }: TerminalTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState(presetAlias ?? '')
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'idle' })
  const [authPrompt, setAuthPrompt] = useState<AuthPromptState | undefined>(undefined)
  const [authInputs, setAuthInputs] = useState<string[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const connRef = useRef<TerminalConnection | null>(null)
  const dataSubRef = useRef<IDisposable | null>(null)
  /** The tab key the live connection belongs to (undefined when disconnected). */
  const connKeyRef = useRef<string | undefined>(undefined)
  const fontSource = terminalFont ?? NO_FONT_SOURCE
  const fontOverride = useSyncExternalStore(fontSource.subscribe, fontSource.get)

  // Tabs and their session ids live in the controller, not in component state:
  // the layout unmounts this page whenever another panel is selected.
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  const readSnapshot = useCallback(() => controller.getSnapshot(), [controller])
  const snapshot = useSyncExternalStore(subscribe, readSnapshot)
  const tabs = snapshot.terminalTabs
  const activeKey = snapshot.activeTerminalKey
  const activeTab = tabs.find(tab => tab.key === activeKey)

  useEffect(() => { ensureXtermCss() }, [])

  // Live re-apply a terminal-font change (issue #577): xterm re-measures
  // and repaints on the options write; a refit keeps cols/rows aligned with
  // the new metrics and the remote PTY learns the new size.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const next = resolveTerminalFontFamily(fontOverride)
    if (term.options.fontFamily === next) return
    term.options.fontFamily = next
    fitRef.current?.fit()
    connRef.current?.resize(term.cols, term.rows)
  }, [fontOverride])

  // Fetch the host list on tab activation.
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const list = await api.listHosts()
        if (!disposed) setHosts(list)
      } catch (cause) {
        if (!disposed) setStatus({ kind: 'error', detail: errorMessage(cause) })
      }
    })()
    return () => { disposed = true }
  }, [api])

  // A hosts-tab connect action preselects its alias here.
  useEffect(() => {
    if (presetAlias !== undefined) setAlias(presetAlias)
  }, [presetAlias])

  /**
   * Tear the view down.
   * @param leave - `detach` leaves the host session alive for a reattach
   *   (tab switch, panel switch, unmount); `close` ends it (the close control).
   */
  const teardown = (leave: 'detach' | 'close'): void => {
    setAuthPrompt(undefined)
    setAuthInputs([])
    connKeyRef.current = undefined
    const connection = connRef.current
    connRef.current = null
    if (connection !== null) {
      connection.onReady = undefined
      connection.onOutput = undefined
      connection.onExit = undefined
      connection.onAuthPrompt = undefined
      if (leave === 'detach') connection.detach()
      else connection.close()
    }
    // Release the xterm input subscription explicitly and dispose the
    // terminal so no listener (or the terminal Renderer) survives a
    // disconnect or the tab unmounting.
    dataSubRef.current?.dispose()
    dataSubRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
  }

  // Unmount cleanup (never touches state on an unmounting component). The
  // host keeps every shell alive, so returning to this page reattaches to the
  // focused tab instead of opening a second session.
  useEffect(() => () => { teardown('detach') }, [])

  // Keep the terminal fitted to its container. A window resize is only one
  // trigger: the status banner appearing after connect, panel resizes, and
  // sidebar toggles all change the container without a window resize, so the
  // container itself is observed (otherwise the viewport keeps the pre-banner
  // height and the last line is clipped below the fold). ResizeObserver may
  // be absent (jsdom tests); the window listener then remains the only path.
  useEffect(() => {
    let lastCols = -1
    let lastRows = -1
    const sync = (): void => {
      const term = termRef.current
      const fit = fitRef.current
      if (term === null || fit === null) return
      fit.fit()
      const conn = connRef.current
      if (conn !== null && (term.cols !== lastCols || term.rows !== lastRows)) {
        lastCols = term.cols
        lastRows = term.rows
        conn.resize(term.cols, term.rows)
      }
    }
    window.addEventListener('resize', sync)
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') {
      return () => { window.removeEventListener('resize', sync) }
    }
    const observer = new ResizeObserver(() => { sync() })
    observer.observe(container)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])

  /**
   * Build the xterm view for one tab and bind one connection to it.
   * @param key - the tab key the connection belongs to.
   * @param open - opens the transport once the terminal has a size.
   */
  const startSession = (key: string, open: (cols: number, rows: number) => TerminalConnection): void => {
    const container = containerRef.current
    if (container === null) return
    teardown('detach')
    setStatus({ kind: 'connecting' })
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: resolveTerminalFontFamily(fontOverride),
      theme: { background: '#0b0e14', foreground: '#d8dee9', cursor: '#a3b8d0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    const connection = open(term.cols, term.rows)
    termRef.current = term
    fitRef.current = fit
    connRef.current = connection
    connKeyRef.current = key
    let settled = false
    let connectedAlias = ''
    dataSubRef.current = term.onData(data => { connection.send(data) })
    connection.onAuthPrompt = (name, instructions, prompts) => {
      setAuthPrompt({ name, instructions, prompts })
      setAuthInputs(prompts.map(() => ''))
    }
    connection.onReady = (id, readyAlias) => {
      // Remember the host session on ITS tab, so a later mount of this page
      // reattaches to the same shell instead of opening a second one.
      connectedAlias = readyAlias
      controller.setTerminalSession(key, id)
      setAuthPrompt(undefined)
      setAuthInputs([])
      setStatus({ kind: 'connected', alias: readyAlias })
    }
    connection.onOutput = data => { term.write(data) }
    connection.onExit = (_code, error) => {
      if (settled) return
      settled = true
      setAuthPrompt(undefined)
      setAuthInputs([])
      dataSubRef.current?.dispose()
      dataSubRef.current = null
      term.options.disableStdin = true
      connRef.current = null
      connKeyRef.current = undefined
      // The session is gone: drop its tab so the next mount starts fresh.
      controller.closeTerminalTab(key)
      // Keep the last output visible; input is now disabled.
      setStatus({ kind: 'exited', alias: connectedAlias !== '' ? connectedAlias : alias, detail: error })
    }
  }

  // Follow the focused tab: detach the previous shell (it stays alive on the
  // host) and attach/open the newly focused one.
  useEffect(() => {
    if (activeTab === undefined) {
      if (connRef.current !== null) {
        teardown('detach')
        setStatus({ kind: 'idle' })
      }
      return
    }
    if (connKeyRef.current === activeTab.key) return
    const key = activeTab.key
    const sessionId = activeTab.sessionId
    if (sessionId !== undefined) {
      startSession(key, (cols, rows) => api.attachTerminal(sessionId, cols, rows))
    } else {
      const target = activeTab.alias
      startSession(key, (cols, rows) => api.openTerminal(target, cols, rows))
    }
  }, [activeTab?.key, activeTab?.sessionId, activeTab?.alias])

  /** Open a tab for the selected alias (the Connect control). */
  const connect = (): void => {
    if (alias === '') return
    controller.requestConnect(alias)
  }

  /**
   * Close one tab. The focused tab's live connection ends the host session
   * with an explicit close frame; a background tab has no connection, so a
   * short-lived attach is used to send that frame (the host replays the
   * scrollback first, then ends the shell) — otherwise the session would only
   * disappear after the host idle timeout.
   */
  const closeTab = (key: string): void => {
    const tab = tabs.find(candidate => candidate.key === key)
    if (tab === undefined) return
    if (connKeyRef.current === key) {
      teardown('close')
      setStatus({ kind: 'idle' })
    } else if (tab.sessionId !== undefined) {
      const connection = api.attachTerminal(tab.sessionId, 80, 24)
      connection.onReady = () => { connection.close() }
      connection.onExit = () => undefined
    }
    controller.closeTerminalTab(key)
  }

  /** Close the focused tab (the Disconnect control). */
  const disconnect = (): void => {
    if (activeKey === undefined) return
    closeTab(activeKey)
  }

  const submitAuth = (e?: React.FormEvent): void => {
    e?.preventDefault()
    if (connRef.current === null || authPrompt === undefined) return
    connRef.current.sendAuthResponse(authInputs)
    setAuthPrompt(undefined)
  }

  const tabLabel = (tab: TerminalTabState): string => tab.sessionId === undefined && tab.key !== activeKey
    ? tab.alias
    : tab.alias

  return (
    <div className={css.termBody}>
      <div className={css.controls}>
        <select className={css.input} value={alias} onChange={event => { setAlias(event.target.value) }}>
          <option value="">{tt('terminal.selectHost')}</option>
          {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} ({host.host})</option>)}
        </select>
        <button type="button" className={css.primaryButton} disabled={alias === ''} onClick={connect}>{tt('terminal.connect')}</button>
        <button type="button" className={css.ghostButton} disabled={activeKey === undefined} onClick={disconnect}>{tt('terminal.disconnect')}</button>
      </div>
      {tabs.length > 0 && (
        <div className={css.termTabs} role="tablist" aria-label={tt('terminal.tabs')}>
          {tabs.map(tab => (
            <div key={tab.key} className={css.termTab} data-active={tab.key === activeKey ? '' : undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.key === activeKey}
                className={css.termTabLabel}
                title={tab.alias}
                onClick={() => { controller.activateTerminalTab(tab.key) }}
              >
                {tabLabel(tab)}
              </button>
              <button
                type="button"
                className={css.termTabClose}
                aria-label={tt('terminal.closeTab')}
                title={tt('terminal.closeTab')}
                onClick={(event) => { event.stopPropagation(); closeTab(tab.key) }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className={css.termTabAdd}
            aria-label={tt('terminal.newTab')}
            title={tt('terminal.newTab')}
            disabled={alias === ''}
            onClick={connect}
          >
            +
          </button>
        </div>
      )}
      {status.kind === 'connecting' && <div className={css.banner} data-kind="info">{tt('terminal.connecting')}</div>}
      {status.kind === 'connected' && <div className={css.banner} data-kind="ok">{tt('terminal.ready', { alias: status.alias })}</div>}
      {status.kind === 'exited' && (
        <div className={css.banner} data-kind="info">{tt('terminal.exited', { alias: status.alias })}{status.detail !== undefined ? ' (' + status.detail + ')' : ''}</div>
      )}
      {status.kind === 'error' && <div className={css.banner} data-kind="error">{tt('terminal.error', { error: status.detail })}</div>}
      <div className={css.termWrap}>
        <div ref={containerRef} className={css.termContainer} data-dsh-part="terminal" />
        {tabs.length === 0 && (
          <div className={css.termPlaceholder}>{hosts.length === 0 ? tt('hosts.empty') : tt('terminal.placeholder')}</div>
        )}
        {authPrompt !== undefined && (
          <div className={css.modalBackdrop} style={{ position: 'absolute', zIndex: 10 }}>
            <form className={css.modalCard} style={{ maxWidth: 420 }} onSubmit={submitAuth}>
              <div className={css.modalHeader}>
                <h3 className={css.modalTitle}>{authPrompt.name || tt('terminal.auth.title')}</h3>
              </div>
              <p className={css.hint}>{authPrompt.instructions || tt('terminal.auth.hint')}</p>
              {authPrompt.prompts.map((p, idx) => (
                <label key={idx} className={css.field}>
                  <span className={css.fieldLabel}>{p.prompt.trim() || tt('terminal.auth.title')}</span>
                  <input
                    autoFocus={idx === 0}
                    className={css.input}
                    type={p.echo ? 'text' : 'password'}
                    placeholder={tt('terminal.auth.placeholder')}
                    value={authInputs[idx] ?? ''}
                    onChange={event => {
                      const next = [...authInputs]
                      next[idx] = event.target.value
                      setAuthInputs(next)
                    }}
                  />
                </label>
              ))}
              <div className={css.modalFooter}>
                <button type="button" className={css.ghostButton} onClick={disconnect}>{tt('terminal.auth.cancel')}</button>
                <button type="submit" className={css.primaryButton}>{tt('terminal.auth.submit')}</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
