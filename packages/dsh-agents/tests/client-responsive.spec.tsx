// @vitest-environment jsdom
/**
 * Narrow-viewport contract of the agents page.
 *
 * The user drives this GUI from a phone through remote-web-ui, so a 360px wide
 * center column may not scroll sideways. These cases read the shipped
 * stylesheet and mount the one component that carries free text, so the
 * reasoning behind the rule - a zero min-width chain, min() grids, wrapping and
 * a line clamp - is pinned next to the rule itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemberCard } from '../src/client/MemberCard.tsx'
import { SessionRow } from '../src/client/SessionRow.tsx'
import { t } from '../src/client/locales.ts'
import { mount, unmountAll } from './render.tsx'
import { memberOf } from './agents-fixtures.ts'
import css from '../src/client/agents.module.css'

/**
 * Locate the shipped stylesheet from either runner shape: the package's own
 * config starts in the package directory, the monorepo runner does not. Both
 * are covered by walking up from the working directory.
 */
function sheetPath(): string {
  const relative = '/src/client/agents.module.css'
  const candidates: string[] = [process.cwd() + '/packages/dsh-agents' + relative]
  let dir = process.cwd()
  for (let depth = 0; depth < 4; depth += 1) {
    candidates.push(dir + relative)
    dir = dirname(dir)
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('agents.module.css not found from ' + process.cwd())
}

const sheet = readFileSync(sheetPath(), 'utf8')

/**
 * The declarations of one class rule, or '' when the rule is absent.
 * @param selector - the exact class selector, including the leading dot.
 */
function rule(selector: string): string {
  const start = sheet.indexOf(selector + ' {')
  if (start < 0) return ''
  const open = sheet.indexOf('{', start)
  const close = sheet.indexOf('}', open)
  return open < 0 || close < 0 ? '' : sheet.slice(open + 1, close)
}

/** The one element matching a selector, failing loudly when it is absent. */
function must(container: ParentNode, selector: string): Element {
  const found = container.querySelector(selector)
  if (found === null) throw new Error('no element matching ' + selector)
  return found
}

afterEach(() => { unmountAll() })

describe('agents page narrow viewport', () => {
  it('operator sees the page column keep a zero min-width chain so nothing overflows sideways', () => {
    // Given the page root, its scroll container and the card wrappers
    // When a 360px viewport lays them out
    // Then every flex/grid ancestor allows shrinking below its content width
    expect(rule('.page')).toContain('min-inline-size: 0')
    expect(rule('.page')).toContain('overflow: hidden')
    expect(rule('.body')).toContain('overflow-x: hidden')
    expect(rule('.memberCard')).toContain('min-inline-size: 0')
    expect(rule('.headerTitle')).toContain('min-inline-size: 0')
  })

  it('operator sees the card grids never demand more width than the column has', () => {
    // Given both grids
    // When the column is narrower than one ideal card
    // Then min() caps the track floor at 100% instead of a fixed 240/260px
    expect(rule('.squadGrid')).toContain('minmax(min(240px, 100%), 1fr)')
    expect(rule('.memberGrid')).toContain('minmax(min(260px, 100%), 1fr)')
    expect(sheet).not.toContain('white-space: nowrap')
  })

  it('operator sees the long brief clamped inside its wrapper instead of stretching the card', () => {
    // Given the member brief rule
    const brief = rule('.memberBrief')
    // When a long brief is rendered
    // Then the rule clamps at three lines and wraps anywhere it must
    expect(brief).toContain('-webkit-line-clamp: 3')
    expect(brief).toContain('overflow: hidden')
    expect(brief).toContain('overflow-wrap: anywhere')
    // And the rendered wrapper is the element that rule targets
    const briefText = 'A brief long enough to need the clamp: it reviews the diff, names the risky parts, and says what to test before the build runs.'
    const view = mount(
      <MemberCard
        member={memberOf({ brief: briefText })}
        run={undefined}
        busy={false}
        notice={undefined}
        onRun={() => {}}
        onOpenSession={undefined}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    const wrapper = view.container.querySelector('[data-dsh-part="member-brief"]')
    expect(wrapper?.className).toBe(css.memberBrief)
    expect(wrapper?.textContent).toBe(briefText)
  })

  it('operator sees a narrow-viewport rule tighten the page gutters', () => {
    // Given the stylesheet
    // When the viewport is phone-wide
    // Then the gutters shrink so the cards keep usable width
    expect(sheet).toContain('@media (max-width: 420px)')
    expect(sheet).toContain('padding: 8px 12px 20px')
  })

  it('operator sees the filled action use the shared primary-button tokens', () => {
    // Given the primary action rule
    const primary = rule('.primary')
    // When a skin themes the page
    // Then the fill, its hover and the foreground come from the trio, never
    // from the brand colour (which would paint text and fill the same)
    expect(primary).toContain('var(--dsw-alias-button-primary-fill')
    expect(primary).toContain('var(--dsw-alias-label-primary-foreground')
    expect(rule('.primary:hover:not(:disabled)')).toContain('var(--dsw-alias-button-primary-hover')
    expect(sheet).not.toContain('--dsw-alias-brand-primary')
  })

  it('operator sees the stylesheet own every class it names', () => {
    // Given the stylesheet
    // When another package renames a private class
    // Then this page is unaffected, because it declares no global or foreign
    // selector and does not reach into a sibling plugin's surface
    expect(sheet).not.toContain(':global')
    expect(sheet).not.toContain('task-board')
    expect(sheet).not.toContain('module.css')
  })
})

describe('agents squad rows on a narrow viewport', () => {
  it('operator sees the new row grids cap their track floor at the column width', () => {
    // Given the live-team and run-history grids
    // When a 360px column lays them out
    // Then min() caps each track at 100% instead of a fixed 260/320px floor
    expect(rule('.teamGrid')).toContain('minmax(min(260px, 100%), 1fr)')
    expect(rule('.runGrid')).toContain('minmax(min(320px, 100%), 1fr)')
    expect(rule('.teamGrid')).toContain('min-inline-size: 0')
    expect(rule('.runGrid')).toContain('min-inline-size: 0')
  })

  it('operator sees a squad row wrap a long name instead of truncating it', () => {
    // Given the row and its title rule
    expect(rule('.row')).toContain('min-inline-size: 0')
    expect(rule('.rowTitle')).toContain('min-inline-size: 0')
    expect(rule('.rowTitle')).toContain('overflow-wrap: anywhere')
    // When a teammate carries a name longer than the row
    expect(rule('.rowTitle')).not.toContain('text-overflow')
    expect(rule('.rowTitle')).not.toContain('nowrap')
    const longName = 'A teammate name long enough that the row has to wrap it rather than cut it'
    const view = mount(
      <SessionRow
        variant="teammate"
        title={longName}
        badge={t('squad.teammate')}
        status={{ label: t('squad.phase.active'), tone: 'active' }}
      />,
    )
    // Then the whole name renders inside the wrapping title
    const title = must(view.container, '[data-dsh-part="squad-team-row"] h5')
    expect(title.className).toBe(css.rowTitle)
    expect(title.textContent).toBe(longName)
  })

  it('operator sees a run status announced, written out and drawn, never colour alone', () => {
    // Given one run-history row
    const view = mount(
      <SessionRow
        variant="squad-run"
        title={t('squad.lead')}
        badge={t('squad.kind.squad')}
        status={{ label: t('member.status.running'), tone: 'active' }}
        time={{ iso: '1970-01-01T00:00:01.000Z', label: t('member.status.running') }}
      />,
    )
    // When it renders
    const status = must(view.container, '[data-dsh-part="run-status"]')
    // Then the live region carries the state as text, with a decorative glyph
    // beside it and the colour slot as reinforcement only
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe(t('member.status.running'))
    expect(status.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(status.className).toContain(css.toneActive)
  })

  it('operator sees the run status line reserve its height so a run cannot move its neighbours', () => {
    // Given the two status lines
    expect(rule('.runStatus')).toContain('min-block-size: 18px')
    expect(rule('.rowStatus')).toContain('min-block-size: 18px')
    // When a member that never ran renders its card
    const view = mount(
      <MemberCard
        member={memberOf()}
        run={undefined}
        busy={false}
        notice={undefined}
        onRun={() => {}}
        onOpenSession={undefined}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    // Then the line is already there, empty, holding its space
    expect(must(view.container, '[data-dsh-part="member-run-status"]').textContent).toBe('')
  })

  it('operator sees every action keep a 44px touch target', () => {
    // Given the three action rules the page ships
    // When the page is driven from a phone
    // Then every one of them is at least 44x44 CSS pixels
    expect(rule('.primary')).toContain('min-block-size: 44px')
    expect(rule('.secondary')).toContain('min-block-size: 44px')
    expect(rule('.danger')).toContain('min-block-size: 44px')
  })

  it('operator sees motion stay reversible and vanish under the reduced-motion preference', () => {
    // Given the stylesheet
    // When the reader has not asked for reduced motion
    // Then the only motion is a reversible background transition, never an
    // entrance animation that keeps anyone waiting
    expect(sheet).toContain('transition: background-color 120ms ease')
    expect(sheet).not.toContain('@keyframes')
    expect(sheet).not.toContain('animation:')
    // And the preference removes it without moving anything
    expect(sheet).toContain('@media (prefers-reduced-motion: reduce)')
    const reduced = sheet.slice(sheet.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('transition: none')
  })
})
