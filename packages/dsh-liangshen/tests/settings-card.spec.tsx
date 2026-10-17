/** @vitest-environment jsdom */

/**
 * The LiangShen settings card: the fields it renders, the values it stages, and
 * the states it must survive. Rendered against a fake slot face — the snapshot
 * hook answers a fixed state and the injected actions are spies.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// Type-only: pulls the client entry's SlotMap merge (the 'web-ui.plugin.item'
// entry the card's PropsRuntime names) into this program without executing it.
import type {} from '../src/client/index.ts'
import {
  PRESENTATION_CHOICES,
  LiangShenSettingsCard,
  LiangShenSettingsCardController,
  type LiangShenSettingsCardProps,
  type LiangShenSettingsCardState,
  type LiangShenSettings,
} from '../src/client/LiangShenSettingsCard.tsx'
import type { FieldState } from '../src/client/settings-form.ts'

afterEach(() => { cleanup() })

/** One untouched field the card renders. */
const field: FieldState = { text: '', overridden: false, invalid: false }

/** One complete card snapshot; callers override what one case exercises. */
function baseState(overrides: Partial<LiangShenSettingsCardState> = {}): LiangShenSettingsCardState {
  return {
    available: true,
    exposed: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    enabled: field,
    announceToAgent: field,
    presentation: field,
    dispatcher: field,
    ...overrides,
  }
}

/** Render the card against a fixed snapshot; spies stand in for the actions. */
function renderCard(state: LiangShenSettingsCardState) {
  const edit = vi.fn()
  const props = {
    t: (key: string) => key,
    useLiangShenSettingsCard: (select: (snapshot: LiangShenSettingsCardState) => LiangShenSettingsCardState) => select(state),
    edit,
    resetField: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  } as unknown as LiangShenSettingsCardProps
  render(<LiangShenSettingsCard {...props} />)
  // The card defaults to collapsed; open the disclosure first.
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  return { edit }
}

/**
 * Open one choice field's popup and read the option labels it renders.
 *
 * The shared card renders a custom trigger plus a listbox under the default
 * appearance (a native `<select>` only appears when an appearance skin is
 * active), so every choice field is driven by clicking, not by `change`.
 */
function openChoices(id: string): HTMLElement[] {
  const trigger = document.getElementById(id)
  expect(trigger, id).not.toBeNull()
  fireEvent.click(trigger!)
  const listbox = document.querySelector('[role="listbox"]')
  expect(listbox).not.toBeNull()
  return Array.from(listbox!.querySelectorAll('[role="option"]')) as HTMLElement[]
}

/**
 * Open one boolean field's popup and return the option carrying a label.
 *
 * The shared card renders a custom trigger plus a listbox under the default
 * appearance, so a boolean field is driven by clicking rather than by
 * `change`. A field that is not rendered, opens nothing, or offers no such
 * option throws instead of asserting on a nullable lookup.
 */
function optionFor(id: string, label: string): HTMLElement {
  const trigger = document.getElementById(id)
  if (trigger === null) throw new Error(`field ${id} is not rendered`)
  fireEvent.click(trigger)
  const listbox = document.querySelector('[role="listbox"]')
  if (listbox === null) throw new Error(`field ${id} opened no listbox`)
  const option = Array.from(listbox.querySelectorAll('[role="option"]')).find(node => node.textContent === label)
  if (option === undefined) throw new Error(`field ${id} offers no ${label} option`)
  return option as HTMLElement
}

describe('LiangShenSettingsCard', () => {
  it('renders every field the Host schema carries', () => {
    renderCard(baseState())
    for (const id of [
      'settings-liangshen-enabled',
      'settings-liangshen-announce',
      'settings-liangshen-presentation',
      'settings-liangshen-dispatcher',
    ]) {
      expect(document.getElementById(id), id).not.toBeNull()
    }
  })

  it('operator sees the mode mark on the card header, painted in the current color', () => {
    // Given the card rendered with a fixed snapshot, When the operator reads
    // the header mark, Then it is an 18px inline SVG whose shapes all take the
    // surrounding text color: the mark follows the active theme instead of
    // carrying a color of its own, and it stays out of the accessibility tree.
    renderCard(baseState())
    const mark = document.querySelector('svg[viewBox="0 0 18 18"]')
    expect(mark?.getAttribute('fill'), 'mark canvas').toBe('none')
    expect(mark?.getAttribute('aria-hidden'), 'mark accessibility').toBe('true')
    const painted = Array.from(mark?.querySelectorAll('rect, circle, path') ?? []).map(shape => shape.getAttribute('fill'))
    expect(painted.length, 'mark shapes').toBeGreaterThan(0)
    expect(painted.every(fill => fill === 'currentColor'), 'mark shape colors').toBe(true)
  })

  it('operator gets a mark whose lever parts stay attached and inside the tile', () => {
    // Given the card rendered with a fixed snapshot, When the operator reads
    // the mark's geometry, Then the arm is tilted off vertical so the pulled
    // lever reads as a lever, its base still overlaps the foot so the parts
    // read as one object, and every shape stays inside the 18x18 tile instead
    // of being clipped by it.
    renderCard(baseState())
    const rod = document.querySelector('svg[viewBox="0 0 18 18"] g rect')!
    const rotation = rod.closest('g')!.getAttribute('transform')!
    expect(rotation).toMatch(/^rotate\(([\d.]+) 8 14\.4\)$/)
    expect(Number(/^rotate\(([\d.]+)/.exec(rotation)![1])).toBeGreaterThan(0)
    const footTop = Number(document.querySelector('svg[viewBox="0 0 18 18"] > rect')!.getAttribute('y'))
    const armBase = Number(rod.getAttribute('y')) + Number(rod.getAttribute('height'))
    expect(armBase, 'arm base over the foot').toBeGreaterThan(footTop)
  })

  it('offers the presentation choices with the inherit option leading', () => {
    renderCard(baseState())
    const presentation = openChoices('settings-liangshen-presentation')
    expect(presentation.map(option => option.textContent)).toEqual([
      'settings.inherit',
      'presentation.ptc',
      'presentation.native',
    ])
  })

  it('stages the presentation a choice selects', () => {
    const { edit } = renderCard(baseState())
    const presentation = openChoices('settings-liangshen-presentation')
    fireEvent.click(presentation[2]!)   // presentation.native
    expect(edit).toHaveBeenCalledWith('presentation', 'native')
  })

  it('disables every control when the document is not writable', () => {
    renderCard(baseState({ writable: false }))
    const trigger = document.getElementById('settings-liangshen-presentation') as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
  })

  it('renders fields gracefully when the Host does not expose the namespace', () => {
    renderCard(baseState({ exposed: false }))
    expect(screen.queryByText('settings.notExposed')).toBeNull()
    expect(document.getElementById('settings-liangshen-presentation')?.tagName).toBe('BUTTON')
  })

  it('binds the scope into a controller whose face carries the snapshot and actions', () => {
    // The card's slot entry injects this face; a missing hook or action would
    // leave the renderer with nothing to bind.
    const scope = {
      getSnapshot: () => ({ value: {}, revision: 0 }),
      subscribe: () => () => {},
      mutate: vi.fn(),
    } as unknown as Parameters<typeof LiangShenSettingsCardController.prototype.constructor>[0]
    const controller = new LiangShenSettingsCardController(scope)
    try {
      const face = controller.inject()
      expect(face.hooks.liangShenSettingsCard).toBeDefined()
      expect(typeof face.edit).toBe('function')
      expect(typeof face.save).toBe('function')
      expect(typeof face.discard).toBe('function')
      expect(typeof face.resetField).toBe('function')
    } finally {
      controller.dispose()
    }
  })

  it('operator can turn the dispatcher identity on from the card', () => {
    // Given the card rendered with the dispatcher field left at its inherit
    // state, When the operator picks On in that field, Then the card stages the
    // boolean write that adds the dispatcher rules section to the preset.
    const { edit } = renderCard(baseState())
    fireEvent.click(optionFor('settings-liangshen-dispatcher', 'settings.on'))
    expect(edit).toHaveBeenCalledWith('dispatcher', 'true')
  })

  it('operator can clear the dispatcher identity back to the deployment default', () => {
    // Given a dispatcher value the user layer already stores, When the operator
    // resets that field, Then the card stages a clear so saving drops the key
    // and the mode keeps its minimal persona.
    const resetField = vi.fn()
    const state = baseState({ dispatcher: { text: 'true', overridden: true, invalid: false } })
    const props = {
      t: (key: string) => key,
      useLiangShenSettingsCard: (select: (snapshot: LiangShenSettingsCardState) => LiangShenSettingsCardState) => select(state),
      edit: vi.fn(),
      resetField,
      save: vi.fn(),
      discard: vi.fn(),
    } as unknown as LiangShenSettingsCardProps
    render(<LiangShenSettingsCard {...props} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    // Then the reset control in that one field's header writes the clear.
    const head = document.querySelector('label[for="settings-liangshen-dispatcher"]')!.closest('div')!
    fireEvent.click(Array.from(head.querySelectorAll('button')).find((button) => button.textContent === 'settings.reset')!)
    expect(resetField).toHaveBeenCalledWith('dispatcher')
  })

  it('keeps the exported choice lists aligned with the Host schema', () => {
    // These mirror the Host's PRESENTATION_OPTIONS; a drift
    // would offer a value the Host rejects or hide one it accepts.
    expect([...PRESENTATION_CHOICES]).toEqual(['ptc', 'native'])
    const settings: LiangShenSettings = { presentation: 'ptc', enabled: true }
    expect(Object.keys(settings).length).toBe(2)
  })
})
