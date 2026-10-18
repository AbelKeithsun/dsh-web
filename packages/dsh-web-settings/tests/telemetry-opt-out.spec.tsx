/** @vitest-environment jsdom */

/**
 * The family-wide telemetry opt-out control in the Web Plugins settings
 * section: it reflects the stored preference, writes it back, and reports the
 * browser's Do Not Track state without pretending the switch caused it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TelemetryToggle } from '../src/client/TelemetryToggle.tsx'
import { en } from '../src/client/locales.ts'

/** English translate stub, reading the published dictionary. */
const t = (key: string): string => (en as Record<string, string>)[key] ?? key

const OPT_OUT_KEY = 'dsh-web-ui-telemetry-opt-out'
const DNT_NOTE = en['telemetry.dnt']

/** Minimal Storage double; Node's partial global localStorage leaks into jsdom here. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => { map.delete(key) },
    setItem: (key, value) => { map.set(key, String(value)) },
  }
}

const checkbox = (): HTMLInputElement => screen.getByRole('checkbox') as HTMLInputElement

describe('TelemetryToggle', () => {
  let store: Storage

  beforeEach(() => {
    store = memoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
    Object.defineProperty(navigator, 'doNotTrack', { value: undefined, configurable: true })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(navigator, 'doNotTrack', { value: undefined, configurable: true })
  })

  it('Visitor who stored nothing sees an unchecked switch and no Do Not Track note', () => {
    // Given: this browser stores no opt-out and sends no Do Not Track signal.
    // When: the Web Plugins section renders the control.
    render(<TelemetryToggle t={t} />)
    // Then: the switch reads as off and the DNT note is absent.
    expect(checkbox().checked).toBe(false)
    expect(screen.queryByText(DNT_NOTE)).toBeNull()
    expect(screen.getByText(en['telemetry.label']).textContent).toBe(en['telemetry.label'])
  })

  it('Visitor who clicks the switch stores the family-wide opt-out', () => {
    // Given: the section rendered with an unchecked switch.
    render(<TelemetryToggle t={t} />)
    // When: the visitor switches telemetry off.
    fireEvent.click(checkbox())
    // Then: the shared storage key holds '1' and the switch reads as on.
    expect(store.getItem(OPT_OUT_KEY)).toBe('1')
    expect(checkbox().checked).toBe(true)
  })

  it('Visitor who already opted out sees the switch on arrival', () => {
    // Given: a previous session stored the opt-out.
    store.setItem(OPT_OUT_KEY, '1')
    // When: the section renders the control.
    render(<TelemetryToggle t={t} />)
    // Then: the switch reports the stored preference.
    expect(checkbox().checked).toBe(true)
  })

  it('Visitor whose browser sends Do Not Track sees the note while the switch stays off', () => {
    // Given: the browser answers Do Not Track and nothing is stored.
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })
    // When: the section renders the control.
    render(<TelemetryToggle t={t} />)
    // Then: the note explains the heartbeat stopped on its own and the switch is off.
    expect(screen.getByRole('status').textContent).toBe(DNT_NOTE)
    expect(checkbox().checked).toBe(false)
  })

  it('Visitor whose browser sends Do Not Track and who also opted out sees no note', () => {
    // Given: Do Not Track is on and the switch is already stored as off.
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })
    store.setItem(OPT_OUT_KEY, '1')
    // When: the section renders the control.
    render(<TelemetryToggle t={t} />)
    // Then: the preference itself explains the state, so the note stays hidden.
    expect(screen.queryByText(DNT_NOTE)).toBeNull()
    expect(checkbox().checked).toBe(true)
  })
})
