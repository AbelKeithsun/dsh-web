/**
 * The one right-sidebar navigation action this plugin drives.
 *
 * The header shortcut must leave the user looking at the browser view without
 * opening a second copy of it: if the session already holds a browser-view tab
 * the shortcut focuses that tab, and only when there is none does it open one.
 * Both calls live on the sidebar service, which is also the owner of where the
 * tab lands, so this module owns only the binding between that service and the
 * narrow face the component takes.
 *
 * Only the session id is widened: the service brands it, while a component
 * cannot name the branded type, and the id the framework hands the shortcut IS
 * that session id - so the assertion states a fact rather than inventing one.
 * Everything else is read through the service's own published signature.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { BROWSER_VIEW_TAB_KIND } from './tab-type.ts'

/** The branded session id the sidebar service expects. */
type SessionKey = Parameters<ClientContext['sidebarRight']['tabsIn']>[0]

/** The tab-record slice this plugin reads. */
export interface BrowserViewTabRecord {
  /** The tab's identity, which focusing it needs. */
  readonly id: string
  /** The tab type's discriminator; only browser-view tabs are ours. */
  readonly kind: string
}

/** Business face injected into the header shortcut. */
export interface BrowserViewSidebarTabs {
  /**
   * Reveal this session's browser-view tab, opening one when it has none.
   * @param sessionId - the session the shortcut was pressed in.
   */
  ensureOpen(sessionId: string): void
}

/**
 * Bind the sidebar service to {@link BrowserViewSidebarTabs}.
 *
 * Both calls are documented to fail loudly for a session whose store the
 * runtime has not minted yet, and the shortcut can be pressed in that window
 * (the column has never been drawn for this session). A press that cannot land
 * yet is not worth a broken GUI: the next press works.
 * @param source - the sidebar service from the client context.
 * @returns the guarded face.
 */
export function bindBrowserViewSidebarTabs(source: ClientContext['sidebarRight']): BrowserViewSidebarTabs {
  return {
    ensureOpen(sessionId: string): void {
      let existing: BrowserViewTabRecord | undefined
      try {
        // tabsIn reports the session's committed tabs; an unadopted session has
        // none, which reads the same as "open one" and is the right answer.
        existing = source.tabsIn(sessionId as SessionKey).find((tab) => tab.kind === BROWSER_VIEW_TAB_KIND)
      } catch {
        existing = undefined
      }
      try {
        if (existing === undefined) source.openTabIn(sessionId as SessionKey, BROWSER_VIEW_TAB_KIND)
        else source.focus(existing.id)
      } catch {
        // The tab type or the session store is not there yet; see above.
      }
    },
  }
}
