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
 * - `user-questions/request` is claimed the same way and published as
 *   `question.request` to the devices that declared `questions.v1`; their
 *   `question.answer` settles the host's own ask while it is open, or reaches a
 *   continued question through the host's Remote `answer`. Every other case
 *   delegates, and the question keeps the Host's own deadline.
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
import { createRemoteBridgeFace, RemoteBridgeRegistry, REMOTE_BRIDGE_SERVICE } from './core/extension.ts'
import { JobRoster, type JobRegistryFace } from './core/jobs.ts'
import { BridgeHub } from './core/hub.ts'
import { createOwnerPeer } from './core/owner-peer.ts'
import { PairingService } from './core/pairing.ts'
import { QuestionClaims } from './core/questions.ts'
import { WS_PATH } from './core/protocol.ts'
import { SessionMeta, type SessionStoreFace, type SessionTitleFace, type WorkspacesFace } from './core/session-meta.ts'
import { SessionPermissions, type ApprovalPolicyFace, type PermissionPresetsFace, type SandboxPolicyFace } from './core/session-permissions.ts'
import { dshHome } from './host/dsh-home.ts'
import { mountOnce } from './mount-once.ts'
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
 * All of them are read per call rather than captured at mount: none is in this
 * plugin's `inject` list, because requiring them would let the title or
 * workspace plugin's absence take the whole bridge down with it. An unmounted
 * service simply reads as undefined, and the protocol degrades one key of one
 * row instead of failing a method. The faces are structural — this package
 * imports no part of those services' own types.
 *
 * One registry answers two faces: `archive` is the slice a roster row reads and
 * `workspaces` the wider slice `workspace.list` publishes, so a single lookup
 * serves both and a host either composes a registry or composes none.
 * @param ctx - the plugin's context.
 * @returns the metadata faces as they stand right now.
 */
function sessionMetaFaces(ctx: Context) {
  const registry = ctx.get('workspaceRegistry') as WorkspacesFace | undefined
  return {
    sessions: ctx.get('sessions') as SessionStoreFace | undefined,
    titles: ctx.get('sessionTitle') as SessionTitleFace | undefined,
    archive: registry,
    workspaces: registry,
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
 * Resolve the host's job registry, now.
 *
 * Read per call, never captured at mount, for the reason the metadata faces
 * are: `jobs` is not in this plugin's `inject` list, so a host that composes
 * no job plugin still serves protocol v1 — `jobs.list` answers
 * `jobs-unavailable` instead of the bridge failing to start. The face is
 * structural: this package imports no part of the registry's own types.
 * @param ctx - the plugin's context.
 * @returns the job faces as they stand right now.
 */
function jobFaces(ctx: Context) {
  return {
    jobs: ctx.get('jobs') as JobRegistryFace | undefined,
  }
}

/**
 * Mount the bridge.
 *
 * Guarded by the family's single-instance rule: the aggregate row
 * (`web-ui-remote-bridge`) and a standalone install of this same package can
 * both be live in one profile, and the second mount would otherwise register
 * `/ios/v1` and the token route a second time. Whichever source mounts first
 * owns the package name; the other is queued and replayed when that owner
 * disposes.
 * @param ctx - the plugin's context, carrying the gateway and web server.
 */
function applyImpl(ctx: Context): void {
  const log = (message: string): void => { console.log(`[remote-bridge] ${message}`) }
  const roster = new DeviceRoster({ file: join(dshHome(), ROSTER_PATH), log })
  const pairing = new PairingService()
  const approvals = new ApprovalRegistry()
  // The owner peer is the full-control credential the gateway demands since
  // 0.2.1; it is safe to hold from mount because every call that can trigger
  // it is gated by the bridge's own pairing check (see core/owner-peer.ts).
  const ownerPeer = createOwnerPeer(ctx)
  const questions = new QuestionClaims({ gateway: ctx.typertGateway, peer: ownerPeer, log })
  // One roster per mount, shared by every connection: a background job is a fact
  // about the host, not about the device that asked about it.
  const jobs = new JobRoster({ faces: () => jobFaces(ctx), log })
  const sessionMeta = new SessionMeta(() => sessionMetaFaces(ctx), () => Date.now(), log)
  const permissions = new SessionPermissions(() => permissionFaces(ctx), log)
  // The extension seam publishes no protocol vocabulary of its own: another
  // plugin registers the method names, payloads and topics it owns, and this
  // package only dispatches and fans out what it was handed.
  const extensions = new RemoteBridgeRegistry()
  const hub = new BridgeHub({
    extensions,
    gateway: ctx.typertGateway,
    pairing,
    roster,
    approvals,
    questions,
    jobs,
    sessionMeta,
    permissions,
    ownerPeer,
    now: () => Date.now(),
    clientTimeZone: localTimeZone,
    log,
  })

  // A capture-only test context implements no service registry; a Host always
  // does. Without it the bridge still serves protocol v1, minus other plugins'
  // methods, which is exactly what not publishing the seam means.
  if (typeof (ctx as { provide?: unknown }).provide === 'function') {
    ctx.provide(REMOTE_BRIDGE_SERVICE, createRemoteBridgeFace(extensions, hub))
  }

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
      jobs.dispose()
    }
  }, 'remote-bridge: protocol v1 routes')

  ctx.on('approval/request', (request, next) => hub.approve(request, next))
  // Prepended: the host's waterfall is first-come, and the desktop client's own
  // answerer would otherwise claim every question before this listener is
  // consulted. The claim starts the rest of the chain itself, so prepending does
  // not take the desktop panel away — both surfaces show the question and the
  // first answer settles it.
  ctx.on('user-questions/request', (request, next) => hub.question(request, next), { prepend: true })
}

/**
 * The plugin's mount point: {@link applyImpl} behind the family's
 * single-instance guard. The name is the npm package identity, which every
 * install source of this plugin shares — the aggregate's `web-ui-remote-bridge`
 * row and the standalone `remote-bridge` row alike.
 */
export const apply = mountOnce('@linxin666/dsh-remote-bridge', applyImpl)
