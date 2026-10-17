/**
 * The 0.2.1-rc.2 webServer type leaves `ctx.webServer.port` undefined until
 * the listener binds (a recompose pass can run this apply ahead of the bind).
 * The host half must degrade honestly in that window: the loopback proxies
 * refuse with 503 (remote-api.spec.ts / remote-upgrade.spec.ts), the posture
 * probe skips the round, and the quick tunnel defers to a re-plan instead of
 * minting an http://127.0.0.1:undefined target (tunnel-plan.spec.ts). This
 * file pins those guards inside applyImpl, the same source-body idiom as
 * lan-bind-hmr-nesting.spec.ts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/**
 * The body of one top-level const declaration inside applyImpl, found by brace
 * balance from its opening brace.
 * @param name - the local const's name.
 * @returns the function body source, without the closing brace.
 */
function bodyOf(name: string): string {
  const head = new RegExp('const ' + name + ' = \\([^)]*\\): void => \\{')
  const match = head.exec(source)
  if (match === null) throw new Error('no ' + name + ' declaration in src/index.ts')
  const start = match.index + match[0].length - 1
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  throw new Error('unbalanced braces after ' + name)
}

describe('webServer port unsettled (0.2.1-rc.2)', () => {
  it('operator skips the posture round while the port is unbound', () => {
    // Given the posture probe, whose LAN targets and requests need the bound port
    // When the port has not settled yet
    // Then the round is skipped before any target or probe is built — the
    // previous snapshot stays and the next trigger retries
    const probe = bodyOf('runPostureProbe')
    const guard = probe.indexOf('if (port === undefined) return')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(probe.indexOf('postureTargets('))
    expect(guard).toBeLessThan(probe.indexOf('probePosture({'))
  })

  it('operator defers the quick tunnel instead of planning an undefined target', () => {
    // Given the settings sync that applies the tunnel plan
    // When autoTunnel is on while the port is unbound
    // Then the plan branch is deferred behind the port-settle guard (with a
    // retry timer), so sync never plans against an unsettled port
    const syncBody = bodyOf('sync')
    expect(syncBody).toContain('livePort === undefined && value.autoTunnel === true')
    expect(syncBody).toContain('PORT_SETTLE_RETRY_MS')
    expect(syncBody).not.toContain('tunnelPlanOf(')
    // The planner only runs inside the apply helper, behind the guard.
    const apply = bodyOf('applyTunnelPlan')
    expect(apply).toContain('tunnelPlanOf(value, port)')
  })

  it('operator clears the port-settle retry with the tunnel lifecycle', () => {
    // Given the deferral retry timer
    // When the plugin disposes
    // Then the pending timer goes with the tunnel teardown
    const clearAt = source.indexOf('clearTimeout(portSettleTimer)')
    expect(clearAt).toBeGreaterThan(-1)
    // The clear sits inside the auto-tunnel dispose effect, ahead of its label.
    expect(clearAt).toBeLessThan(source.indexOf("'remote-web-ui: auto tunnel'"))
  })
})
