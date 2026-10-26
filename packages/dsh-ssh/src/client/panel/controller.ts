/**
 * SSH panel controller: the single owner of the panel's view state.
 *
 * Framework-free (structural runtime faces, task-board core/controller.ts
 * style) so the sidebar row and the React panel share one tiny subscription
 * surface. The state lives only for the browser session (no persistence).
 *
 * The active tab, the terminal tab list and each tab's host session id live
 * here rather than inside the panel components: the layout mounts a keyed page
 * only while its panel is selected, so component-local state would reset the
 * tabs on every panel switch and lose the ids a reattach needs.
 *
 * Terminal tabs: one record per client-side view. A tab is created before its
 * host session exists (opening one is asynchronous), so `key` is client-side
 * and `sessionId` is filled in when the socket reports ready. Closing a tab
 * removes the record; the caller ends the host session (close frame) when it
 * still has a live connection for it.
 */

/** The panel's tab identifiers. */
export type SshTab = 'hosts' | 'terminal' | 'transfer' | 'tunnels' | 'cluster'

/** Stable id shared by the sidebar panel row and the main-slot page. */
export const SSH_PANEL_ID = 'ssh'

/** One terminal tab: a client-side view bound to at most one host PTY session. */
export interface TerminalTabState {
  /** Client-side key, stable for the tab's whole lifetime (the view picks it). */
  key: string
  /** Host alias the tab was opened for. */
  alias: string
  /** Host-side session id, known once the terminal socket reported ready. */
  sessionId?: string
}

/** Immutable controller snapshot for UI subscriptions. */
export interface PanelControllerSnapshot {
  /** Whether the center column shows this panel. */
  panelOpen: boolean
  /** The tab the panel is showing. */
  activeTab: SshTab
  /** Terminal tabs in creation order. */
  terminalTabs: readonly TerminalTabState[]
  /** The terminal tab the terminal view shows; undefined when there is none. */
  activeTerminalKey: string | undefined
}

/**
 * The layout's panel-navigation face: selecting the panel is the layout's
 * business, and this is the one call that asks for it (null returns the column
 * to the conversation). Optional, so a shell-less composition keeps the pure
 * state transitions testable.
 */
export interface PanelNavigationFace {
  /** Select this panel, or null to hand the column back to the conversation. */
  select(panelId: string | null): void
}

/** Controller dependencies. */
export interface PanelControllerDeps {
  /** Layout panel selection; absent keeps the controller state-only. */
  panel?: PanelNavigationFace
}

/** Monotonic key source (one counter per page, like the connect nonce). */
let nextTerminalTabKey = 1

/** The panel state owner the sidebar row and the view both read. */
export class PanelController {
  private panelOpen = false
  private activeTab: SshTab = 'hosts'
  private terminalTabs: TerminalTabState[] = []
  private activeTerminalKey: string | undefined
  private listeners = new Set<() => void>()
  /** Cached so getSnapshot is referentially stable between changes. */
  private snapshot: PanelControllerSnapshot = {
    panelOpen: false,
    activeTab: 'hosts',
    terminalTabs: [],
    activeTerminalKey: undefined,
  }

  constructor(private readonly deps: PanelControllerDeps = {}) {}

  getSnapshot(): PanelControllerSnapshot {
    return this.snapshot
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /**
   * Show the panel. The layout owns which panel the column renders, so the
   * state flip and the selection travel together; the selection is requested
   * after the snapshot flips, so a subscriber never observes "open" while the
   * shell still shows the conversation.
   */
  open(): void {
    if (this.panelOpen) return
    this.panelOpen = true
    this.commit()
    this.selectPanel(SSH_PANEL_ID)
  }

  /** Return the column to the conversation, asking the layout explicitly. */
  close(): void {
    if (!this.panelOpen) return
    this.panelOpen = false
    this.commit()
    this.selectPanel(null)
  }

  toggle(): void {
    if (this.panelOpen) this.close()
    else this.open()
  }

  /**
   * Reflect a selection made outside this controller (the user clicked another
   * sidebar row, or the layout dropped the panel id).
   * @param panelId - the layout's current panel id, or null for the conversation.
   */
  syncPanelSelection(panelId: string | null): void {
    const open = panelId === SSH_PANEL_ID
    if (open === this.panelOpen) return
    this.panelOpen = open
    this.commit()
  }

  /** Switch panel tabs, keeping the terminal tabs and their sessions. */
  setActiveTab(tab: SshTab): void {
    if (this.activeTab === tab) return
    this.activeTab = tab
    this.commit()
  }

  /**
   * Open a terminal tab for the alias (the hosts-tab "connect" action and the
   * terminal tab's own Connect button both land here) and make it active.
   * @param alias - the configured host alias.
   * @returns the new tab's client-side key.
   */
  requestConnect(alias: string): string {
    if (this.activeTab !== 'terminal') this.activeTab = 'terminal'
    return this.openTerminalTab(alias)
  }

  /**
   * Create a terminal tab for the alias and focus it. The view opens the host
   * session on the next render; an existing tab for the same alias is left
   * alone (multi-tab means a second shell on the same host is allowed).
   * @param alias - the configured host alias.
   * @returns the new tab's client-side key.
   */
  openTerminalTab(alias: string): string {
    const key = 'terminal-tab-' + String(nextTerminalTabKey)
    nextTerminalTabKey += 1
    this.terminalTabs = [...this.terminalTabs, { key, alias }]
    this.activeTerminalKey = key
    this.commit()
    return key
  }

  /** Focus one terminal tab (no-op for an unknown key). */
  activateTerminalTab(key: string): void {
    if (this.activeTerminalKey === key) return
    if (!this.terminalTabs.some(tab => tab.key === key)) return
    this.activeTerminalKey = key
    this.commit()
  }

  /**
   * Record the host session a tab's socket reported, so a later mount
   * reattaches to the same shell instead of opening a second one.
   */
  setTerminalSession(key: string, sessionId: string): void {
    const tab = this.terminalTabs.find(candidate => candidate.key === key)
    if (tab === undefined || tab.sessionId === sessionId) return
    this.terminalTabs = this.terminalTabs.map(candidate => candidate.key === key ? { ...candidate, sessionId } : candidate)
    this.commit()
  }

  /** Forget one tab's host session (it exited); the tab record itself stays. */
  clearTerminalSession(key: string): void {
    const tab = this.terminalTabs.find(candidate => candidate.key === key)
    if (tab === undefined || tab.sessionId === undefined) return
    this.terminalTabs = this.terminalTabs.map(candidate => {
      if (candidate.key !== key) return candidate
      const { sessionId: _dropped, ...rest } = candidate
      return rest
    })
    this.commit()
  }

  /**
   * Remove one terminal tab. When it was the focused tab, focus moves to the
   * tab that took its place (or the one before it), so closing the last tab
   * leaves no focus behind.
   * @param key - the tab's client-side key.
   * @returns the removed tab (the caller ends its host session), or undefined.
   */
  closeTerminalTab(key: string): TerminalTabState | undefined {
    const index = this.terminalTabs.findIndex(candidate => candidate.key === key)
    if (index < 0) return undefined
    const removed = this.terminalTabs[index]!
    this.terminalTabs = this.terminalTabs.filter(candidate => candidate.key !== key)
    if (this.activeTerminalKey === key) {
      const fallback = this.terminalTabs[index] ?? this.terminalTabs[index - 1]
      this.activeTerminalKey = fallback?.key
    }
    this.commit()
    return removed
  }

  private commit(): void {
    this.snapshot = {
      panelOpen: this.panelOpen,
      activeTab: this.activeTab,
      terminalTabs: this.terminalTabs,
      activeTerminalKey: this.activeTerminalKey,
    }
    for (const fn of [...this.listeners]) fn()
  }

  /** Ask the layout to select a panel; a shell without the face is a no-op. */
  private selectPanel(panelId: string | null): void {
    try {
      this.deps.panel?.select(panelId)
    } catch {
      // The layout service throws by contract before its root entry mounts;
      // the state flip above already stands and the next selection retries.
    }
  }
}
