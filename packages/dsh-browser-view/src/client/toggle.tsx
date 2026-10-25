/**
 * Session-header shortcut for the browser view.
 *
 * Registered into 'conversation.session.header.actions' (list/session), so it
 * sits beside the shipped header buttons rather than replacing them. The
 * browser view lives in the right sidebar, so pressing this button reveals that
 * column's browser-view tab - focusing the one this session already has, and
 * opening one only when it has none.
 *
 * The button carries no pressed state. Whether the column is expanded and which
 * chip is in front belong to the shell's tab strip, and a shortcut that claims
 * to be a toggle without owning either end of the toggle would be lying to
 * assistive technology.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserViewSidebarTabs } from './sidebar-tabs.ts'
import { BROWSER_VIEW_PARTS, BROWSER_VIEW_PLUGIN } from './semantic.ts'
import css from './panel.module.css'

/** Business face injected into the header action. */
export interface BrowserViewToggleFace {
  /** Sidebar navigation: reveal this session's browser-view tab. */
  readonly tabs: BrowserViewSidebarTabs
  /** Session the button was rendered for. */
  readonly sessionId: string
}

/** Toggle props: the locale seat plus the injected face. */
export type BrowserViewToggleProps = PropsLocale<'browser-view'> & Partial<BrowserViewToggleFace>

/**
 * Window-and-cursor mark for the header button; inline, no icon dependency.
 * @returns the button glyph.
 */
function BrowserViewIcon() {
  return (
    <svg className={css.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M1.75 6.25h12.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.2 8.6l4 1.9-1.7.7-.7 1.7z" fill="currentColor" />
    </svg>
  )
}

/**
 * Render the header action button.
 * @param props - composed slot props.
 * @returns the shortcut button.
 */
export function BrowserViewToggle({ t, tabs, sessionId }: BrowserViewToggleProps) {
  const label = t('toggle.open')
  return (
    <button
      type="button"
      className={css.toggle}
      data-dsh-plugin={BROWSER_VIEW_PLUGIN}
      data-dsh-part={BROWSER_VIEW_PARTS.toggle}
      aria-label={label}
      title={label}
      onClick={() => {
        if (tabs === undefined || sessionId === undefined) return
        tabs.ensureOpen(sessionId)
      }}
    >
      <BrowserViewIcon />
      <span className={css.toggleLabel}>{t('toggle.label')}</span>
    </button>
  )
}
