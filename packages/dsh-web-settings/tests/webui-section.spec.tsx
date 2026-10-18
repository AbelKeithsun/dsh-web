/** @vitest-environment jsdom */

/**
 * The Web UI section contract: it renders a static heading and immediately
 * renders every family plugin card through the child slot (no disclosure fold:
 * the nav entry already selects the section).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { WebUIPluginsSection } from '../src/client/WebUIPluginsCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * English translate stub (same shape the sibling settings-card tests use).
 * Reads from the published dictionary and falls back to the key.
 */
const t = (key: string): string => (en as Record<string, string>)[key] ?? key

describe('WebUIPluginsSection', () => {
  it('renders the heading alone and the family plugin cards immediately', () => {
    const renderSlot = vi.fn(() => null)
    const props = { t, renderSlot } as ComponentProps<typeof WebUIPluginsSection>
    const { container } = render(<WebUIPluginsSection {...props} />)

    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading.textContent).toBe('Web Plugins')
    // The nav cell already names the section, so the lede that restated it is
    // gone: the section's own children hold the heading, the telemetry card and
    // the card list, and no paragraph of section-level copy. Card copy lives
    // inside the cards, which is why this counts direct children only.
    const section = container.firstElementChild as HTMLElement
    expect(Array.from(section.children).filter(child => child.tagName === 'P')).toHaveLength(0)
    // The page-level telemetry setting renders through the same card chrome as
    // the plugin cards below it: a list-item card whose header control is a
    // switch named by that card's own title, not by a copy of the label text.
    const switchEl = screen.getByRole('switch')
    const titleId = switchEl.getAttribute('aria-labelledby') ?? ''
    const namedBy = Array.from(container.querySelectorAll('[id]')).find(node => node.id === titleId)
    expect(namedBy?.textContent).toBe(en['telemetry.title'])

    expect(renderSlot).toHaveBeenCalledTimes(1)
    expect(renderSlot).toHaveBeenCalledWith('web-ui.plugin.item', {})
  })
})
