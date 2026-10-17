/**
 * `@linxin666/dsh-remote-bridge` — the Host half of the DSH remote bridge.
 *
 * One plugin row exposes the frozen protocol v1 to a paired remote client:
 *
 * - `/ios/v1` (WebSocket upgrade) carries the whole protocol. Admission is
 *   unconditional: a connection without a valid device token is UNPAIRED and
 *   may only call `hello`, `pair.begin` and `pair.finish` — even from loopback.
 * - `/remote-bridge/pair/token` (exact HTTP route) mints the one-shot bootstrap
 *   token. It is admitted only when the request arrives from this machine AND
 *   its `Host` header names this machine: a tunneled request reaches the origin
 *   from loopback too, so the socket address alone is not a loopback proof.
 * - `approval/request` is claimed in-process while a paired device is connected,
 *   and delegated (`next()`) in every other case, which the Host normalizes to
 *   the fail-closed `'unavailable'`.
 *
 * The browser half lives in `src/client/` and is declared by `dsh.client`: one
 * sidebar-foot panel that reads the same loopback-gated token route over a
 * same-origin request and renders the secret as a QR symbol beside its
 * plaintext. It is display-only — it cannot mint, spend, list or revoke
 * anything — and this module does not import it.
 * @module @linxin666/dsh-remote-bridge
 */

import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { ApprovalRegistry } from './core/approvals.ts'
import type { ConnectionAuth } from './core/connection.ts'
import { DeviceRoster } from './core/devices.ts'
import { BridgeHub } from './core/hub.ts'
import { PairingService } from './core/pairing.ts'
import { WS_PATH } from './core/protocol.ts'
import { SessionMeta, type ArchiveSetFace, type SessionStoreFace, type SessionTitleFace } from './core/session-meta.ts'
import { SessionPermissions, type ApprovalPolicyFace, type PermissionPresetsFace, type SandboxPolicyFace } from './core/session-permissions.ts'
import { dshHome } from './host/dsh-home.ts'
import { makePairTokenRoute } from './host/routes.ts'
import { isWebSocketUpgrade, presentedTokenOf, readSecWebSocketKey, refuseUpgrade, serveUpgrade } from './host/websocket.ts'

/** Loader row identity of this plugin. */
export const name = 'remote-bridge'

/** The Host services this plugin cannot run without. */
export const inject = ['typertGateway', 'webServer']

/** Where the paired-device roster lives inside the DSH home. */
export const ROSTER_PATH = 'remote-bridge/devices.json'

/** This machine's IANA time zone, or undefined when the platform has none. */
function localTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone === '' ? undefined : zone
  } catch {
    return undefined
  }
}

/**
 * The `/ios/v1` upgrade handler.
 *
 * A bad, absent or bootstrap token is NOT a refusal: the connection is simply
 * unpaired, which is the state the pairing handshake starts from. Only a
 * malformed handshake is refused.
 */
function makeUpgradeHandler(hub: BridgeHub, roster: DeviceRoster, log: (message: string) => void) {
  return async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    if (!isWebSocketUpgrade(req)) {
      refuseUpgrade(socket, 400, 'Bad Request')
      return
    }
    const key = readSecWebSocketKey(req)
    if (key === undefined) {
      refuseUpgrade(socket, 400, 'Bad Request')
      return
    }
    try {
      await roster.load()
    } catch (error) {
      // An unreadable roster leaves every candidate unpaired. Refusing the upgrade
      // says so; letting the handler's promise reject instead would hand the host's
      // upgrade dispatcher a failure it has no answer for and no client would ever see.
      log(`could not read the device roster: ${String(error)}`)
      refuseUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const token = presentedTokenOf(req)
    const device = token === undefined ? undefined : roster.authenticate(token)
    const auth: ConnectionAuth | undefined = device === undefined ? undefined : { deviceId: device.deviceId }
    serveUpgrade({
      socket,
      secWebSocketKey: key,
      head,
      hub,
      ...(auth === undefined ? {} : { auth }),
    })
  }
}

/**
 * Resolve the host services session metadata is read from, now.
 *
 * All three are read per call rather than captured at mount: none of them is in
 * this plugin's `inject` list, because requiring them would let the title or
 * workspace plugin's absence take the whole bridge down with it. An unmounted
 * service simply reads as undefined, and the protocol degrades one key of one
 * row instead of failing a method. The faces are structural — this package
 * imports no part of those services' own types.
 * @param ctx - the plugin's context.
 * @returns the metadata faces as they stand right now.
 */
function sessionMetaFaces(ctx: Context) {
  return {
    sessions: ctx.get('sessions') as SessionStoreFace | undefined,
    titles: ctx.get('sessionTitle') as SessionTitleFace | undefined,
    archive: ctx.get('workspaceRegistry') as ArchiveSetFace | undefined,
  }
}

/**
 * Resolve the host services permission presets are read and switched through, now.
 *
 * Read per call, never captured at mount, for the reason the metadata faces are:
 * none of these is in this plugin's `inject` list, and a host that composes no
 * permission plugin answers `unknown-method` instead of failing to start. The
 * `Session` object the preset service needs is the store's own live instance —
 * the same object `sessionTitle` already takes — so no second lookup path exists
 * for it.
 * @param ctx - the plugin's context.
 * @returns the permission faces as they stand right now.
 */
function permissionFaces(ctx: Context) {
  return {
    sessions: ctx.get('sessions') as SessionStoreFace | undefined,
    presets: ctx.get('permissionPresets') as PermissionPresetsFace | undefined,
    sandbox: ctx.get('sandboxPolicy') as SandboxPolicyFace | undefined,
    approval: ctx.get('approval') as ApprovalPolicyFace | undefined,
  }
}

/**
 * Mount the bridge.
 * @param ctx - the plugin's context, carrying the gateway and web server.
 */
export function apply(ctx: Context): void {
  const log = (message: string): void => { console.log(`[remote-bridge] ${message}`) }
  const roster = new DeviceRoster({ file: join(dshHome(), ROSTER_PATH), log })
  const pairing = new PairingService()
  const approvals = new ApprovalRegistry()
  const sessionMeta = new SessionMeta(() => sessionMetaFaces(ctx), () => Date.now(), log)
  const permissions = new SessionPermissions(() => permissionFaces(ctx), log)
  const hub = new BridgeHub({
    gateway: ctx.typertGateway,
    pairing,
    roster,
    approvals,
    sessionMeta,
    permissions,
    now: () => Date.now(),
    clientTimeZone: localTimeZone,
    log,
  })

  ctx.effect(() => {
    void roster.load()
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: WS_PATH,
      handler: makeUpgradeHandler(hub, roster, log),
    })
    const disposeRoute = ctx.webServer.register(makePairTokenRoute({ pairing, log }))
    log(`protocol v1 listening on ${WS_PATH}`)
    return () => {
      disposeUpgrade()
      disposeRoute()
      hub.dispose()
    }
  }, 'remote-bridge: protocol v1 routes')

  ctx.on('approval/request', (request, next) => hub.approve(request, next))
}
