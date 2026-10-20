/**
 * Constrained-layout guard: the board must preserve readable columns and let
 * the board scroll horizontally instead of compressing cards into slivers.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/board.module.css', import.meta.url), 'utf8')

describe('board responsive css', () => {
  it('keeps the columns container horizontally scrollable', () => {
    const columnsBlock = css.match(/\.columns\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(columnsBlock).toContain('overflow-x: auto')
    expect(columnsBlock).toContain('overflow-y: hidden')
  })

  it('preserves a readable minimum width for every rendered column', () => {
    const columnsBlock = css.match(/\.columns\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(columnsBlock).toContain('grid-auto-flow: column')
    expect(columnsBlock).toContain('grid-auto-columns: minmax(220px, 1fr)')
  })

  it('renders a visible horizontal scrollbar affordance', () => {
    expect(css).toMatch(/\.columns::\-webkit-scrollbar\s*\{[^}]*height:\s*10px/s)
    expect(css).toMatch(/\.columns::\-webkit-scrollbar-track\s*\{[^}]*background:/s)
    expect(css).toMatch(/\.columns::\-webkit-scrollbar-thumb\s*\{[^}]*background:/s)
    expect(css).toContain('scrollbar-width: thin')
  })

  it('keeps the bottom scrollbar inside the board viewport', () => {
    const boardBlock = css.match(/\.board\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(boardBlock).toContain('box-sizing: border-box')
    expect(boardBlock).toContain('height: 100%')
  })

  it('responds to the board container rather than only the viewport', () => {
    expect(css).toMatch(/\[data-dsh-taskboard-view\]\s*\{[^}]*container-name:\s*task-board-view/s)
    expect(css).toContain('@container task-board-view (max-width: 768px)')
    expect(css).toContain('@container task-board-view (max-width: 720px)')
    expect(css).toContain('@container task-board-view (max-width: 600px)')
    expect(css).toMatch(/\.boardHeader\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(css).toMatch(/\.search\s*\{[^}]*flex:\s*1 0 100%/s)
  })

  it('turns phone columns into one-card-per-swipe snap points', () => {
    expect(css).toMatch(/@container task-board-view \(max-width: 768px\)[\s\S]*?\.columns\s*\{[^}]*grid-auto-columns:\s*86cqw/s)
    expect(css).toMatch(/@container task-board-view \(max-width: 768px\)[\s\S]*?\.columns\s*\{[^}]*scroll-snap-type:\s*inline mandatory/s)
    expect(css).toMatch(/\.column\s*\{[^}]*scroll-snap-align:\s*start[^}]*scroll-snap-stop:\s*always/s)
  })

  it('uses the dynamic viewport and safe areas for phone overlays', () => {
    expect(css).toContain('@media (max-width: 768px)')
    expect(css).toMatch(/\.modalBackdrop\s*\{[^}]*height:\s*100dvh/s)
    expect(css).toMatch(/\.modal,\s*\.detail\s*\{[^}]*height:\s*100dvh[^}]*max-height:\s*none/s)
    expect(css).toContain('env(safe-area-inset-top)')
    expect(css).toContain('env(safe-area-inset-bottom)')
  })

  it('keeps phone actions reachable with touch-sized controls', () => {
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.primaryButton,[\s\S]*?\.scheduleToggle\s*\{[^}]*min-height:\s*44px/s)
    expect(css).toMatch(/\.modalFooter\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/s)
    expect(css).toMatch(/\.detailFooter\s*\{[^}]*flex-wrap:\s*wrap/s)
  })
})

describe('task form regions (create/edit dialogs)', () => {
  it('user opening a task dialog gets a shell that itself never scrolls', () => {
    // Given the task board stylesheet
    // When a task dialog shell renders its body
    const modal = css.match(/^\.modal\s*\{([^}]*)\}/m)?.[1] ?? ''
    const body = css.match(/^\.modalBody\s*\{([^}]*)\}/m)?.[1] ?? ''

    // Then the shell keeps its height fixed and only the body owns the fallback
    expect(modal).toContain('overflow: hidden')
    expect(modal).toContain('max-height: calc(100vh - 96px)')
    expect(body).toContain('overflow-y: auto')
    expect(body).toContain('min-height: 0')
  })

  it('user expanding a region gets a chevron drawn from borders rather than a glyph', () => {
    // Given the task board stylesheet
    // When a form region renders its header
    const chevron = css.match(/^\.formSectionChevron\s*\{([^}]*)\}/m)?.[1] ?? ''

    // Then the chevron is drawn with borders and rotated when the region opens
    expect(chevron).toContain('border-left: 5px solid')
    expect(css).toMatch(/\.formSection\[data-open='true'\] \.formSectionChevron\s*\{[^}]*transform: rotate\(90deg\)/s)
  })
})


describe('task detail panel layout and type hierarchy', () => {
  /** The detail view's own stylesheet region (layout, rows, badges, footer). */
  const detailRegion = css.slice(
    css.indexOf('/* --- detail ---'),
    css.indexOf('/* --- constrained board containers ---'),
  )

  it('user on a wide viewport reads the card in two columns on one baseline', () => {
    // Given the detail region of the stylesheet
    // When the viewport can carry two reading tracks
    // Then the panel is wide enough for them and splits on one start line
    expect(detailRegion).toMatch(/\.detail \{[^}]*width: min\(960px, calc\(100vw - 48px\)\)/s)
    expect(detailRegion).toMatch(/\.detailColumns \{[^}]*align-items: start/s)
    expect(detailRegion).toMatch(/@media \(min-width: 1024px\) \{\s*\.detailColumns \{\s*grid-template-columns: minmax\(0, 1\.15fr\) minmax\(0, 0\.85fr\);\s*\}\s*\}/)
  })

  it('user on a phone falls back to one column with an 8px spacing rhythm', () => {
    // Given the phone treatment of the overlay
    const phone = css.slice(css.indexOf('@media (max-width: 768px)'), css.indexOf('* Polish pass'))

    // When the viewport is too narrow to carry two tracks
    // Then the grid collapses to one column and the panel keeps one rhythm of
    // 8px multiples on both tracks
    expect(phone).toMatch(/\.detailColumns \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s)
    expect(phone).toMatch(/\.detailColumn \{[^}]*gap: 16px/s)
    expect(detailRegion).toMatch(/\.detailColumn \{[^}]*gap: 24px/s)
    expect(detailRegion).toMatch(/\.detailSection \{[^}]*gap: 8px/s)
  })

  it('user reading the panel never meets an 11px label, because the view has three sizes', () => {
    // Given every declared font size in the detail region
    const sizes = [...detailRegion.matchAll(/font-size:\s*([0-9.]+px)/g)].map(match => match[1])

    // When the panel paints its labels and body copy
    // Then none of them is 11px, and the view stays inside the three-step
    // budget of 15 title / 13 body / 12 meta
    expect(sizes).not.toContain('11px')
    expect(new Set(sizes)).toEqual(new Set(['12px', '13px', '15px']))
  })

  it('user scanning execution rows sees one filled badge slot per outcome', () => {
    // Given the badge rules of the history
    const base = detailRegion.match(/^\.executionBadge \{([^}]*)\}/m)?.[1] ?? ''
    const succeeded = detailRegion.match(/\.executionBadge\[data-result='succeeded'\] \{([^}]*)\}/)?.[1] ?? ''
    const failed = detailRegion.match(/\.executionBadge\[data-result='failed'\] \{([^}]*)\}/)?.[1] ?? ''
    const cancelled = detailRegion.match(/\.executionBadge\[data-result='cancelled'\] \{([^}]*)\}/)?.[1] ?? ''

    // When each outcome paints its badge
    // Then every outcome paints a surface of its own instead of mixing a filled
    // running badge with unfilled settled ones
    for (const rules of [base, succeeded, failed, cancelled]) {
      expect(rules).toContain('background: var(--dsw-alias-')
      expect(rules).not.toContain('background: transparent')
    }
    expect(base).toContain('var(--dsw-alias-state-warn-secondary)')
    expect(succeeded).toContain('var(--dsw-alias-state-success-secondary)')
    expect(failed).toContain('var(--dsw-alias-state-error-secondary)')
  })

  it('user in any theme sees tokens only, never a literal colour', () => {
    // Given the detail region the redesign owns
    // When a skin or a light/dark switch resolves the panel
    // Then no literal colour is written, so every theme keeps working by
    // construction
    expect(detailRegion).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(detailRegion).not.toMatch(/\b(rgba?|hsla?|oklch|lab)\(/)
  })

  it('user folding history or acceptance sees the same motion reversed, and only a fade under reduced motion', () => {
    // Given the two folded regions of the panel
    // When either one opens or closes
    // Then both legs exist on the same travel...
    expect(detailRegion).toMatch(/\.executionExtra,[\s\S]{0,200}?animation: dshTbRowsIn var\(--dsh-tb-motion-enter\)/s)
    expect(detailRegion).toMatch(/\.executionExtra\[data-execution-fold='closing'\],[\s\S]{0,240}?animation: dshTbRowsOut var\(--dsh-tb-motion-close\)/s)
    // The panel's own folds (advanced settings, schedule, history) ride the
    // same pair instead of a third disclosure style
    expect(detailRegion).toMatch(/\.detailBody \.formSectionBody \{[^}]*animation: dshTbRowsIn/s)
    expect(detailRegion).toMatch(/\.detailBody \.formSectionBody\[data-state='closing'\] \{[^}]*animation: dshTbRowsOut/s)
    expect(detailRegion).toMatch(/@keyframes dshTbRowsIn \{\s*from \{ opacity: 0; transform: translateY\(-6px\); \}\s*to \{ opacity: 1; transform: translateY\(0\); \}/)
    expect(detailRegion).toMatch(/@keyframes dshTbRowsOut \{\s*from \{ opacity: 1; transform: translateY\(0\); \}\s*to \{ opacity: 0; transform: translateY\(-6px\); \}/)
    // ...and the reduced-motion path keeps the fade while dropping the travel
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.executionExtra,[\s\S]{0,160}?animation: dshTbFadeIn/s)
    expect(reduced).toMatch(/\.executionExtra\[data-execution-fold='closing'\],[\s\S]{0,220}?animation: dshTbFadeOut/s)
  })
})

describe('task board columns and cards share the panel visual contract', () => {
  /** One rule body of the stylesheet, by exact selector. */
  const block = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return css.match(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]*)\\}', 'm'))?.[1] ?? ''
  }
  /** The board frame through the cards: the surface this phase owns. */
  const surface = css.slice(css.indexOf('/* --- board frame ---'), css.indexOf('/* --- buttons ---'))

  it('user reading a column or a card never meets an 11px label, because the surface has three sizes', () => {
    // Given every declared font size on the board frame, its columns and its cards
    const sizes = [...surface.matchAll(/font-size:\s*([0-9.]+px)/g)].map(match => match[1])

    // When a column header, a card title, its excerpt and its meta line paint
    // Then none is 11px and the surface stays inside 15 title / 13 body / 12 meta
    expect(sizes).not.toContain('11px')
    expect(new Set(sizes)).toEqual(new Set(['12px', '13px', '15px']))

    // The label chips are painted from their own section of the stylesheet.
    for (const selector of ['.cardTag', '.tagFilterLabel', '.tagChip']) {
      expect(block(selector), selector).toContain('font-size: 12px')
    }
  })

  it('user scanning a column sees the card left edge under the header content box, on one shared rail', () => {
    // Given the column header and the cards container
    const header = block('.columnHeader')
    const cards = block('.cards')

    // When both lay out inside one column
    // Then each inset reads the column's rail token instead of a pixel value,
    // and the header keeps one height with and without the density switch
    expect(header).toContain('padding: 8px var(--dsh-tb-rail)')
    expect(header).toContain('min-height: calc(var(--dsh-tb-card-row) + 18px)')
    expect(cards).toContain('padding: 2px var(--dsh-tb-rail) 10px')
    // The rail is declared once on the board root, so the columns, the filter
    // row and the panel's label list all resolve the same value
    expect(block('.board')).toContain('--dsh-tb-rail: 12px')
    expect(block('.cardGroupHeader')).toContain('padding: 4px 0 0')
  })

  it('user sees every card element on one content track, because the card is a two-track grid', () => {
    // Given the card and its outcome stripe
    const card = block('.card')
    const stripe = block('.card::before')

    // When a card paints its stripe, title row, excerpt, meta line, labels and actions
    // Then the stripe owns the first track and one placement rule puts every
    // child on the second, so no element can drift off the rail
    expect(card).toContain('grid-template-columns: var(--dsh-tb-card-stripe) minmax(0, 1fr)')
    expect(card).toContain('column-gap: var(--dsh-tb-card-inset)')
    expect(card).toContain('align-content: start')
    expect(stripe).toContain('width: var(--dsh-tb-card-stripe)')
    expect(block('.card > :not(.cardOpen)')).toContain('grid-column: 2')
    // Compact density changes the rhythm only; the track geometry stays.
    expect(block('.card[data-compact]')).not.toMatch(/(?:^|\s)gap:/)
  })

  it('user hovering, focusing or following a run never sees the card resize', () => {
    // Given the card's state and interaction rules
    const stateRules = [
      '.card:hover',
      '.card:active',
      ".card[data-status='running']",
      '.cardOpen:focus-visible',
      '.cardAction:focus-visible',
      '.densityToggle:focus-visible',
      '.tagChip:focus-visible',
    ]

    // When each state paints
    // Then only paint properties change: a state rule never re-declares a box
    // size, a padding, a gap or a type size
    for (const selector of stateRules) {
      const rules = block(selector)
      expect(rules, selector).not.toBe('')
      expect(rules, selector).not.toMatch(/(?:^|[\s;])(padding|font-size|height|min-height|line-height|border-width|gap|row-gap|column-gap|margin):/)
    }
  })

  it('user sees the spinner, the result badge and the stamp inside reserved slots, so a state change cannot move the card', () => {
    // Given the card's rows and every transient box on them
    // Then each row reserves one slot height and every box inside takes it
    expect(block('.cardMeta')).toContain('min-height: var(--dsh-tb-card-row)')
    expect(block('.cardStatus')).toContain('min-height: var(--dsh-tb-card-row)')
    expect(block('.cardStatus')).toContain('font-size: 12px')
    expect(block('.cardResult')).toContain('line-height: var(--dsh-tb-card-row)')
    expect(block('.cardSchedule')).toContain('height: var(--dsh-tb-card-row)')
    expect(block('.cardSubtask')).toContain('line-height: var(--dsh-tb-card-row)')
    expect(block('.cardSession')).toContain('height: var(--dsh-tb-card-row)')
    expect(block('.cardSpinnerSlot')).toContain('width: var(--dsh-tb-card-row)')
    expect(block('.cardSpinnerSlot')).toContain('height: var(--dsh-tb-card-row)')
    // The stamp keeps its width while it ticks.
    expect(block('.cardTime')).toContain('font-variant-numeric: tabular-nums')
    // An empty label list paints no row at all.
    expect(block('.cardTags:empty')).toContain('display: none')
    // Compact density keeps its own tighter row rhythm.
    expect(block('.card[data-compact]')).toContain('row-gap: 2px')
  })

  it('user scanning outcomes sees one filled badge slot per result, painted from tokens only', () => {
    // Given the card's result badge and its lineage badge
    const base = block('.cardResult')
    const succeeded = block(".cardResult[data-result='succeeded']")
    const failed = block(".cardResult[data-result='failed']")
    const cancelled = block(".cardResult[data-result='cancelled']")

    // When each outcome paints
    // Then every outcome paints a surface of its own, read from the same state
    // slots the detail panel's execution badge uses
    for (const rules of [base, succeeded, failed, cancelled]) {
      expect(rules).toContain('background: var(--dsw-alias-')
      expect(rules).not.toContain('background: transparent')
      expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(rules).not.toMatch(/\b(rgba?|hsla?|oklch|lab)\(/)
    }
    expect(base).toContain('var(--dsw-alias-state-warn-secondary)')
    expect(base).toContain('var(--dsw-alias-state-warn-primary)')
    expect(succeeded).toContain('var(--dsw-alias-state-success-secondary)')
    expect(failed).toContain('var(--dsw-alias-state-error-secondary)')
    expect(block(".cardSubtask[data-tone='failed']")).toContain('var(--dsw-alias-state-error-secondary)')
    expect(block(".cardSubtask[data-tone='running']")).toContain('var(--dsw-alias-state-warn-secondary)')
    expect(block(".cardSubtask[data-tone='done']")).toContain('var(--dsw-alias-state-success-secondary)')
    // The card surface itself writes no literal colour.
    expect(surface).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('user reaching a quick action, the density switch or a label chip gets a 44px pointer target', () => {
    // Given the board's hit-size token
    expect(block('.board')).toContain('--dsh-tb-hit-size: 44px')

    // When a card quick action, a column density switch or a filter chip is pointer-reached
    // Then each expands its target to that token instead of growing its visible box
    for (const selector of ['.cardAction::after', '.densityToggle::after', '.tagChip::after']) {
      expect(block(selector), selector).toContain('width: var(--dsh-tb-hit-size)')
      expect(block(selector), selector).toContain('height: var(--dsh-tb-hit-size)')
    }
    for (const selector of ['.cardAction', '.densityToggle', '.tagChip']) {
      expect(block(selector), selector).toContain('position: relative')
    }
  })
})
