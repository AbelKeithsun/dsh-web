/**
 * Browser half of the dsh-agents plugin: registers the zh/en dictionaries and
 * the two shell seats (sidebar row + center page).
 *
 * The Host half owns the routes and the protocol; this entry needs the slot
 * and locale services and only probes the optional workspace service for its
 * session opener.
 *
 * @module @linxin666/dsh-agents/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createAgentsTransport } from './host-api.ts'
import { registerAgentLocales } from './locales.ts'
import type { LocaleRegistrar } from './locales.ts'
import { registerAgentsPanel } from './panel.tsx'

/**
 * Services cordis waits for before it runs apply. The locale seat is required,
 * not optional: dictionaries registered after the first paint leave the page
 * rendering raw keys, so a load-order race must pend the apply instead of
 * being absorbed. The registration helper keeps its own guard for a deployment
 * that genuinely serves no locale seat.
 */
export const inject = ['slots', 'locale']

/**
 * Resolve the GUI's session opener, if this deployment has the workspace
 * service. It is probed here so the member card can hide the action entirely
 * instead of offering a button that would do nothing.
 * @param ctx - client root context (service: uiWorkspace, optional).
 */
function sessionOpener(ctx: ClientContext): ((sessionId: string) => void) | undefined {
  try {
    const workspace = (ctx as unknown as { uiWorkspace?: { openSession(id: string): void } }).uiWorkspace
    if (workspace === undefined || typeof workspace.openSession !== 'function') return undefined
    return (sessionId: string) => { workspace.openSession(sessionId) }
  } catch {
    return undefined
  }
}

/**
 * Mount the agents plugin.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => registerAgentLocales(ctx as unknown as { locale?: LocaleRegistrar }), 'dsh-agents: dictionaries')

  const transport = createAgentsTransport()
  const openSession = sessionOpener(ctx)
  ctx.effect(() => registerAgentsPanel(ctx, transport, openSession), 'dsh-agents: sidebar row and page')
}
