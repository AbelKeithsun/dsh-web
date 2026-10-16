/**
 * Host-half entry for the dsh-win-bash plugin.
 *
 * The plugin owns exactly one model-facing capability — the win_bash tool over
 * a per-session persistent bash process — and nothing else. It registers no
 * settings section, no HTTP route and no browser half: the Host renders the
 * configuration form for this row from the exported Config schema.
 *
 * Mount-time integrity: before the tool is registered at all, the vendored
 * payload is checked against its shipped SHA256 manifest. A mismatch refuses
 * the mount with a specific message rather than running commands through
 * bytes nobody verified. The tool is also refused on every non-Windows host
 * and on a Windows host that is not x64, because no PATH bash is ever used as
 * a substitute.
 *
 * Lifecycle: one shell process per calling agent, released when that agent is
 * disposed and when the plugin fiber unloads.
 * @module @linxin666/dsh-win-bash
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig, type WinBashConfig, type WinBashConfigInput } from './config.ts'
import { resolveRuntime, type HostPlatform } from './runtime.ts'
import { ShellRegistry } from './shell.ts'
import { buildWinBashTool } from './tool.ts'

export { Config }
export type { WinBashConfig, WinBashConfigInput }
export { CONFIG_DEFAULTS, DEFAULT_DESCRIPTION, validateConfig } from './config.ts'
export { WIN_BASH_TOOL } from './tool.ts'
export { ShellRegistry, ShellUnavailableError } from './shell.ts'
export { buildFrame, markerFor, parseFrame } from './protocol.ts'
export {
  bashPath,
  parseChecksums,
  resolveRuntime,
  runtimeRoot,
  shPath,
  verifyPayload,
} from './runtime.ts'

/** Cordis plugin name; also the loader row id this package mounts under. */
export const name = 'dsh-win-bash'

/** Required services: the tool registry and the managed subprocess seam. */
export const inject = ['tools', 'subprocess']

/**
 * Mount the plugin.
 * @param ctx - context carrying tools and subprocess.
 * @param config - the row's config, validated by {@link Config}.
 */
export function apply(ctx: Context, config?: WinBashConfigInput): void {
  const host: HostPlatform = { platform: process.platform, arch: process.arch }
  const runtime = resolveRuntime(host)
  if ('code' in runtime) {
    // Refusing the mount is the point: there is no fallback shell, and a
    // mounted tool that always errors is worse than an honest absence.
    ctx.logger?.warn?.('dsh-win-bash: win_bash was not mounted (' + runtime.code + '): ' + runtime.message)
    return
  }
  let resolved: WinBashConfig
  try {
    resolved = resolveConfig(config)
  } catch (error) {
    ctx.logger?.error?.('dsh-win-bash: ' + (error instanceof Error ? error.message : String(error)))
    throw error
  }
  const shells = new ShellRegistry(ctx.subprocess)
  const tool = buildWinBashTool(ctx, resolved, runtime, shells)

  ctx.effect(() => {
    const unregister = ctx.tools.register(tool)
    return async () => {
      unregister()
      // Unload must reach quiescence: the shells are real processes the host
      // would otherwise keep hosting with nobody able to talk to them.
      await shells.disposeAll('the dsh-win-bash plugin was unloaded')
    }
  }, 'dsh-win-bash: win_bash tool and its persistent shells')

  // One session's shell dies with that session. The agent object is the key,
  // so a session that ends for any reason (close, archive, reload) releases
  // its process instead of leaving it to the plugin's own disposal.
  ctx.on('agent/disposed', ({ agent }) => {
    void shells.dispose(agent, 'the owning agent was disposed')
  })
}
