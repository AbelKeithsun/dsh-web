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
import { LiveActivityNotifier } from './core/liveactivity.ts'
import { PushNotifier } from './core/push.ts'
import { QuestionClaims } from './core/questions.ts'
import { WS_PATH } from './core/protocol.ts'
import { SessionMeta, type SessionStoreFace, type SessionTitleFace, type WorkspacesFace } from './core/session-meta.ts'
import { SessionPermissions, type ApprovalPolicyFace, type PermissionPresetsFace, type SandboxPolicyFace } from './core/session-permissions.ts'
import { UsageService, type CredentialStoreFace, type SettingsFace } from './core/usage.ts'
import { dshHome } from './host/dsh-home.ts'
import { ApnsSender, apnsConfigFromEnv } from './host/apns.ts'
import { StandingWatchers } from './host/watchers.ts'
import { LoopbackSquads } from './host/squads.ts'
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
 * 解析 `usage.v1` 要读的宿主服务，现在就解析一次。
 *
 * 与元数据的三个 face 同一条理由：三者都不在本插件的 `inject` 里，缺一个不该
 * 让整个桥起不来。缺活会话存储，`usage.session` 就只能靠本进程观察过的事件
 * 判断会话是否存在；缺凭据服务，`usage.balance` 回 `no-credential`；缺设置
 * 服务，路由的 `baseURL` 与 `apiKeyEnv` 读不到，origin 判定与凭据回退都退回
 * 官方默认值。face 是结构化的：本包不导入这些服务自己的类型。
 * @param ctx - 插件的上下文。
 * @returns 这些 face 此刻的样子。
 */
function usageFaces(ctx: Context) {
  return {
    sessions: ctx.get('sessions') as SessionStoreFace | undefined,
    credentials: ctx.get('credentials') as CredentialStoreFace | undefined,
    settings: ctx.get('settings') as SettingsFace | undefined,
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
  // 用量读数：一条会话的窗口与组成靠宿主广播的事件折出来，余额靠宿主自己的
  // 凭据与设置查出来。一个宿主一份、所有连接共享——两台手机重复问，上游也只
  // 该收到一次请求（core/usage.ts）。
  const usage = new UsageService({ faces: () => usageFaces(ctx), now: () => Date.now(), log })
  // The push channel is OFF unless this machine holds an Apple signing key: no
  // key, no sender, and every notification path is a no-op — which is what keeps
  // the protocol byte-identical for every deployment that has none (§28).
  const apns = apnsConfigFromEnv()
  // One client for both channels: an APNs provider token is minted per key and
  // then reused, so a second client would only double the mint rate Apple
  // throttles (core/push.ts, host/apns.ts).
  const apnsSender = apns === undefined ? undefined : new ApnsSender({ config: apns, log })
  const push = new PushNotifier({
    targets: () => roster.pushTargets().map(({ push: registration }) => ({
      deviceToken: registration.deviceToken,
      environment: registration.environment,
      bundle: registration.bundle,
      ...(registration.locale === undefined ? {} : { locale: registration.locale }),
    })),
    ...(apnsSender === undefined ? {} : { sender: apnsSender }),
    titles: id => sessionMeta.title(id),
    now: () => Date.now(),
    log,
  })
  // The lock-screen card path (§29). It reads the same roster, through the same
  // client, and is inert for exactly the same reason: no key, no sender, no card.
  // A token APNs reports dead is dropped from its device row here, which is the
  // whole of the recovery — the next card registers a fresh one.
  const liveActivity = new LiveActivityNotifier({
    targets: () => roster.pushTargets().flatMap(({ push: registration }) => (registration.liveActivityTokens ?? []).map(({ activityId, token, sessionId }) => ({
      activityId,
      token,
      // The session is the card's address (§29.9). A registration written before
      // that field existed simply has none, and its card is never pushed to.
      ...(sessionId === undefined ? {} : { sessionId }),
      environment: registration.environment,
      bundle: registration.bundle,
    }))),
    ...(apnsSender === undefined ? {} : { sender: apnsSender }),
    now: () => Date.now(),
    log,
    retire: async (activityId, token) => {
      const dropped = await roster.removeLiveActivityToken(activityId, token)
      // A dead token is a roster change like any other: the session it named may
      // have just lost its last card, and a watcher for it must close.
      if (dropped) watchers.sync()
      return dropped
    },
  })
  // The bridge's own follow streams (§28/§29): a suspended phone has no socket,
  // so the turn end its card has to show would otherwise be seen by nobody. One
  // watcher per session that still holds a card token, armed from the roster and
  // never from a client frame.
  const watchedSessions = (): readonly string[] => {
    const sessions = new Set<string>()
    for (const { push: registration } of roster.pushTargets()) {
      for (const token of registration.liveActivityTokens ?? []) {
        if (token.sessionId !== undefined) sessions.add(token.sessionId)
      }
    }
    return [...sessions]
  }
  const watchers = new StandingWatchers({
    gateway: ctx.typertGateway,
    peer: ownerPeer,
    sessions: watchedSessions,
    ...(apnsSender === undefined ? {} : { liveActivity, push }),
    log,
  })
  const permissions = new SessionPermissions(() => permissionFaces(ctx), log)
  // The extension seam publishes no protocol vocabulary of its own: another
  // plugin registers the method names, payloads and topics it owns, and this
  // package only dispatches and fans out what it was handed.
  // The squad domain of the `dsh-agents` plugin is read over this host's own
  // loopback origin: that plugin serves its routes on the very web server this
  // bridge already injects. Both the origin and the ledger directory are resolved
  // per call — the listener may not have bound a port when this row mounts, and a
  // DSH home is not a fact to capture once.
  const squads = new LoopbackSquads({
    origin: () => {
      try {
        return ctx.webServer.getOrigin()
      } catch {
        return undefined
      }
    },
    ledgerDirectory: () => join(dshHome(), 'dsh-agents'),
    log,
  })
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
    usage,
    permissions,
    ownerPeer,
    squads,
    push,
    liveActivity,
    onPushRegistered: () => { watchers.sync() },
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
    // A registration that arrived before this row mounted is still on disk: the
    // watchers are reconciled from what the roster holds, not from what a live
    // connection happened to send.
    void roster.load().then(() => { watchers.sync() }).catch(() => undefined)
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: WS_PATH,
      handler: makeUpgradeHandler(hub, roster, log),
    })
    const disposeRoute = ctx.webServer.register(makePairTokenRoute({ pairing, log }))
    log(`protocol v1 listening on ${WS_PATH}`)
    log(apns === undefined
      ? `push: off (set ${'DSH_REMOTE_BRIDGE_APNS_KEY_FILE'}, ${'DSH_REMOTE_BRIDGE_APNS_KEY_ID'} and ${'DSH_REMOTE_BRIDGE_APNS_TEAM_ID'} to enable APNs)`
      : `push: on (APNs key ${apns.keyId} of team ${apns.teamId})`)
    return () => {
      disposeUpgrade()
      disposeRoute()
      watchers.dispose()
      hub.dispose()
      jobs.dispose()
    }
  }, 'remote-bridge: protocol v1 routes')

  // 会话事件是 `usage.session` 唯一的来源：桥不读会话日志、也不回填历史，所以
  // 这个监听器挂上之前广播的事件不会有读数，宿主没广播过的窗口也不会被编出来。
  ctx.on('session/event', (session, event) => { usage.record(session.id, event) })
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
