# dsh-remote-bridge · Protocol v1 Host Adaptor for DeepSeek Harness (DSH)

English | [中文](README.zh.md)

<p align="center">
  <img src="https://img.shields.io/npm/v/@linxin666/dsh-remote-bridge?style=flat-square" alt="Version">
  &nbsp;
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-4c6ef5?style=flat-square&amp;labelColor=454a54" alt="DSH">
  &nbsp;
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License">
</p>

A host-side adaptor that publishes DeepSeek Harness (DSH) itself as protocol v1: one WebSocket surface at `/ios/v1` that a native client — a phone app, a tablet, a terminal — can drive without a browser, without the Web GUI bundle, and without a relay change.

Protocol v1 is deliberately a second, independent surface: the browser path (the paired-device cookie and the gated `/remote` channel) belongs to `dsh-remote-web-ui`, and the bridge does not replay that credential. It consumes the harness in-process instead — the Typert gateway for session work, the approval waterfall for permission requests — and mints its own one-time bootstrap token without changing `dsh-remote-web-ui`'s pairing service.

## What it does

The package publishes one protocol and, beside it, one small browser surface. What the host half publishes is a protocol:

- **One surface.** A WebSocket at `/ios/v1`, registered as an exact upgrade route on the host webserver; frames are text, one JSON object each, at most 10 MiB (10485760 bytes).
- **A session surface.** `session.list`, `session.titles`, `session.snapshot`, `session.prompt` and `session.interrupt` cover the roster with its workspace, lineage and archive metadata, a batch of session titles, a full baseline plus a live subscription, a queued prompt with an idempotency key, and turn cancellation.
- **A subscription, not a poll.** `session.snapshot` opens the harness follow stream and keeps it, so the baseline and every later increment arrive over the same socket.
- **Approvals reach the client.** A tool that asks for permission arrives as an `approval.request` event and is answered with `approval.resolve`; a request nobody answers is rejected.
- **Pairing.** A one-time bootstrap token plus a P-256 challenge-response mint a revocable device token; an unpaired connection reaches three methods only.
- **A pairing panel.** The same plugin row declares a `dsh.client` browser half: a sidebar-foot panel that shows the operator the live one-time code as a QR symbol and in plaintext, with its 30 s countdown and a mint-again action.
- **No relay change.** The protocol rides whatever origin the instance already publishes, and the relay hop forwards it exactly as it forwards everything else.

## Transport

| frame | shape |
| --- | --- |
| request | `{"t":"req","id":<uint>,"m":"<method>","p":{...}}` |
| response | `{"t":"res","id":<uint>,"ok":true,"r":{...}}` or `{"t":"res","id":<uint>,"ok":false,"e":{"code":"<str>","msg":"<str>"}}` |
| event | `{"t":"ev","seq":<uint>,"m":"<topic>","p":{...}}` |
| heartbeat | `{"t":"ping","ts":<ms>}` and `{"t":"pong","ts":<ms>}` |

`seq` is per connection and starts at 1: it numbers the events that connection received, not the harness's own history. Frames are text, one JSON object per frame, at most 10 MiB (10485760 bytes). Idle connections are probed every 20 s; a client answers a ping with a pong of its own and a bridge answers the same way.

## Methods

| method | request `p` | response `r` |
| --- | --- | --- |
| `hello` | `{proto:1, minor:1, client:"ios/0.1", cap:["session.stream.v1","session.snapshot.trim.v1"]}` | `{proto:1, minor:1, server:"dsh-remote-bridge", resume:"snapshot", auth:"paired" or "unpaired"}` |
| `session.list` | `{}` | `{sessions:[{id, title, updatedAt, agentRunning, cwd?, parentSessionId?, origin?, blank, archived?}]}` |
| `session.titles` | `{ids:[<sessionId>, ...]}` | `{titles:{"<id>":"<title>", ...}}` |
| `session.snapshot` | `{sessionId, maxBytes?}` | `{turns:[...], lastSeq:<uint>, hasMore?}` |
| `session.history` | `{sessionId, before?, maxBytes?}` | `{turns:[...], nextBefore?:<uint>, hasMore:<bool>}` |
| `session.prompt` | `{sessionId, text, requestId}` | `{accepted:true}` |
| `session.interrupt` | `{sessionId}` | `{ok:true}` |
| `pair.begin` | `{token}` | `{nonce, expiresAt}` |
| `pair.finish` | `{devicePubKey, signature}` | `{deviceToken, deviceId}` |
| `approval.resolve` | `{id, decision}` | `{ok:true}` |

`hello` is callable without a device token and reports the connection's own `auth` state. `session.snapshot` maps the harness follow stream's opening snapshot into `turns`, reports its cursor as `lastSeq` and then keeps that stream open as this connection's subscription for the session; `session.prompt` ensures the same subscription idempotently, so a client may skip the snapshot. The prompt mode is fixed to queue, `clientTimeZone` is filled server-side with the host's IANA zone, and `requestId` is an idempotency key: the same `requestId` in the same session is sent once, and a repeat answers `{accepted:true}` without sending anything again. `session.interrupt` cancels the turn; it does not drop the subscription.

`hello` also carries the client's capabilities, and a capability is an announcement rather than a negotiation: the handshake answers the same frame whatever `cap` holds, an unknown name is ignored, and the frame cap is one constant in both directions — the 10 MiB that bounds a received frame is the same budget that fits a snapshot and that drops an oversized outbound event. The one capability this protocol version recognizes is `session.snapshot.trim.v1`. A client that does not declare it — including every client written before it existed — is served exactly the baseline protocol v1 always served. A client that does declare it is sent a trimmed baseline: inside every turn, only the entries it renders (`user/message`, `assistant/message`, `tool/call`, `tool/result`) survive, and the harness's own bookkeeping records (`system/message`, `request/header` and the like) are dropped before the frame is measured. Nothing else about the snapshot changes: which turns are kept, their order, and each turn's `seq`, `endSeq`, `reason` and `time` are the projection's own values, a turn whose entries are all bookkeeping stays as a turn with an empty `entries` array, and `lastSeq` is still the harness cursor. The frame budget applies afterwards — entries are trimmed first, then whole oldest turns are dropped, and only then does a snapshot that still does not fit answer `snapshot-too-large`.

A second capability bounds the opening screen itself: `session.snapshot.page.v1`. Without it a snapshot stays the whole opening window, byte for byte, exactly as before. With it, `session.snapshot` answers with the newest page only, measured against `maxBytes` (default 524288 = 512 KiB, and refused rather than clamped when it is not a usable budget), cut by the very same entry-level slice `session.history` uses: a turn's entries may split between this page and the next one while that turn keeps its own fields, an entry larger than the whole budget is a page of its own, and `snapshot-too-large` can no longer answer such a connection. The page carries `lastSeq` and `hasMore`, and the cursor for the next, older page is the `seq` of its own oldest entry — the same value `session.history` takes as `before`, which is why no `nextBefore` field restates it. Opening a session then costs one page, and `session.history` walks the rest of the window back in the same 512 KiB pages.

`session.snapshot` and `session.history` address a session the way the harness demands. An ordinary session is addressed by its own id; a delegated child — a roster row carrying `origin:"subagent"` — is addressable only through its durable parent, and the harness answers `session/agent-busy` when a child is asked as an ordinary session. The bridge learns that from the harness's own refusal rather than guessing: it retries that one session with the delegated address `{kind:"subagent", parentSessionId, childSessionId, mode:"unknown"}` and serves the child's real history. The parent comes from the roster, the only endpoint that carries lineage — a client that listed sessions before opening one pays no extra read, and the roster is read at most once per connection. Roots never pay for this: they open on the first attempt. A session with nothing to show is not a failure either: one whose log holds only the harness's own bookkeeping answers a real projection with an empty turn, and only a missing opening frame or a failure raised by the harness itself is refused.

`session.history` reads a session's history backwards in pages, and it is a pure read: it never opens, drops or re-addresses a subscription, and the same cursor always answers the same page. It is served from the very opening baseline `session.snapshot` uses, so the two can never disagree about a turn or an entry — `history` only slices that projection. Pages are cut BY ENTRY, not by turn: a page carries the newest entries below the caller's cursor until the encoded page reaches `maxBytes` (default 524288 = 512 KiB), a turn's entries may therefore be split across pages while that turn keeps its own `seq`, `endSeq`, `reason` and `time`, and a single entry larger than the whole budget is a page of its own rather than a refusal. `before` is a durable watermark, not an index: the page carries the entries whose `seq` is strictly below it, so a cursor stays meaningful across connections and across a projection that changed shape under it. Omit `before` for the newest page; `hasMore` says whether anything older remains, and `nextBefore` — the cursor for the next, older page — is present exactly while `hasMore` is true. The trim capability applies here exactly as it does to a snapshot.

`session.list` carries the roster's own fields plus the metadata a phone groups and labels by: `cwd`, `parentSessionId` and `origin` are present only when the host reported them, `blank` is always present, and `archived` is present only when this process can read the host's archive set — a bridge that cannot tell omits the key instead of answering `false`. `title` stays `""` unless this connection has already resolved that id through `session.titles`, so listing sessions stays one call and never puts a title read on every row. `session.titles` answers a batch of one to 100 ids out of the host's own title service — the live sessions of this process, never one follow stream per session — and every requested id becomes a key: an id this host does not hold live, or one whose title has not landed yet, answers `""`. One resolved title is served for 10 s before the service is asked again, so a rename can take that long to show. Like every other session method, both answer `unpaired` without a device token.

## Events

| topic | payload |
| --- | --- |
| `session.delta` | `{sessionId, kind, ...}` — one increment of a session's turn (kinds below) |
| `approval.request` | `{sessionId, id, summary}` — a tool is waiting for a decision |

### session.delta kinds

| kind | extra fields | meaning |
| --- | --- | --- |
| `text` | `{text, blockIndex}` | assistant text delta |
| `reasoning` | `{text, blockIndex}` | reasoning delta |
| `tool-call` | `{callId, name, argumentsDelta}` | incremental tool call; `argumentsDelta` may be an empty string |
| `tool-result` | `{callId, output, isError}` | tool result |
| `turn-end` | `{reason}` | turn finished; anything other than `completed` is an abnormal end |

An `approval.request` carries a summary taken from the harness's display reason in the client's language, falling back to English and then to the tool name, plus the tool name itself. The client answers it with `approval.resolve`, whose `decision` is either `allowed-once` or `rejected`; an unknown or expired `id` is refused, and a request nobody answers is resolved after two minutes as unavailable, which the harness reads as a rejection. The bridge claims a request only while a paired client is connected: with none, the request is left to the next answerer instead of waiting out a phone that is not there.

## Extension seam

The package publishes one generic seam and puts no vocabulary of its own in it. Mounted plugins resolve the cordis service `remoteBridge` and add methods and events to protocol v1 without the bridge learning what they mean:

| member | contract |
| --- | --- |
| `registerMethods({capability?, methods})` | adds a table of client-callable methods and returns the disposer that withdraws them; a name inside `KNOWN_METHODS`, an empty name or a name another table already owns is refused, and the whole table is refused with it |
| `broadcast(topic, payload, capability?)` | pushes one event to the connections that are paired — and, when a capability is named, declared it — and returns how many took the frame |

A registered method is dispatched after both protocol gates: a name no plugin registered answers `unknown-method` before anything else runs, a client without a live device token answers `unpaired` exactly as it does for a protocol method, and a client that never declared the table's capability is told `unknown-method` — the method is absent from its protocol rather than forbidden to it. The handler receives the request payload and the calling connection's id, and answers `{ok:true, r}` or `{ok:false, code, msg}`; the bridge forwards either verbatim, because refusal codes belong to the registering plugin. A handler that throws, or answers neither shape, crosses as the bridge's own `internal`.

`hello` answers `minor:1` since this seam shipped. Major 1 and every frozen field, method name and topic name are unchanged by it, so a client that never declares an extension capability sees protocol v1 exactly as before.

## Error codes

| code | meaning |
| --- | --- |
| `unpaired` | the connection has no live device token and the method is outside the unpaired whitelist |
| `snapshot-unavailable` | the session's opening frame could not be read — the follow stream ended without one, or none arrived within 10 s. A failure the harness itself raised crosses with its own code instead |
| `token-invalid` | the bootstrap token is unknown, already spent or older than 30 s |
| `nonce-invalid` | `pair.finish` used a nonce that was never issued, already used or expired |
| `signature-invalid` | the ES256 signature does not verify against the offered public key and nonce |
| `approval-unknown` | `approval.resolve` named an approval id that is unknown or has expired |
| `unknown-method` | the method name is not part of protocol v1 |
| `invalid-args` | the payload does not match the method's shape |
| `proto-unsupported` | the `hello` handshake named a protocol version this bridge does not speak |
| `snapshot-too-large` | the opening snapshot cannot be shrunk to one frame: even a single turn does not fit |
| `internal` | the bridge failed while serving the call |
| `frame-too-large` | the frame exceeded the 10 MiB cap and was not parsed |
| `malformed` | the frame is not one JSON object with a recognizable shape |
| `direction-violation` | the client sent a `res` or `ev` frame, which only the host sends |

A failure raised inside DSH is not re-labelled either: it crosses with the gateway's own code, such as `service-unavailable`, `invocation-unavailable`, `definition-unavailable` or `arguments-invalid`. Only the service-activation window is retried (five tries, two seconds apart), because that is the one failure that succeeds moments later.

## Authentication

The device token rides the WebSocket upgrade as `Authorization: Bearer <deviceToken>` — the preferred carrier — and as `?token=<deviceToken>` for clients that cannot set headers. The comparison is constant length and does not short-circuit on a mismatched size. A connection without a live device token is allowed exactly three methods — `hello`, `pair.begin`, `pair.finish` — and everything else answers `unpaired` before any session work happens.

### Bootstrap token

`GET /remote-bridge/pair/token` is an exact host route behind a two-condition loopback gate: the socket address must be `127.0.0.1`, `::1` or `::ffff:127.0.0.1`, and the `Host` header must name `127.0.0.1`, `localhost` or `[::1]` (its port is ignored). A tunneled request fails the second condition even though its tunnel client connects from this same machine, so the endpoint stays unreachable from the public origin; anything else gets 403. The token is held in memory, expires after 30 s, is spent by the first `pair.begin`, and the same link is printed to the host log while the code itself is rendered in the pairing panel, so a desktop operator can reach it either way.

```sh
curl -s http://127.0.0.1:3080/remote-bridge/pair/token
# {"token":"...","expiresAt":1760000030000,"url":"ws://127.0.0.1:3080/ios/v1?token=..."}
```

When this machine can name its own public origin — `DSH_REMOTE_PUBLIC_BASE_URL`, else the relay registry row `$DSH_HOME/remote-web-ui-registry/<profile>.json` that `dsh-remote-web-ui` keeps — the same answer carries the address half too:

```json
{
  "token": "...",
  "expiresAt": 1760000030000,
  "url": "ws://127.0.0.1:3080/ios/v1?token=...",
  "origin": "wss://<id>.dsh-market.com",
  "originSource": "registry",
  "pairingUrl": "wss://<id>.dsh-market.com/ios/v1?token=..."
}
```

`pairingUrl` is what a pairing QR should carry: the iOS client parses `{token, url}` and adopts the origin from `url`, so one scan sets both the address and the one-shot token and the operator types nothing on the phone. With no discoverable origin those two fields are absent rather than guessed, the panel falls back to a bare-token code, and the phone keeps whatever origin it already has.

### Device token

`pair.begin` answers with a nonce and its expiry; the client signs the nonce's raw bytes with a P-256 key and calls `pair.finish` with the base64url SPKI public key and the base64url ES256 signature. The signature must be the raw 64-byte `r||s` form that WebCrypto and CryptoKit produce, not a DER wrapper: the host checks the length before it verifies, so a re-encoded signature is refused. The host answers with a 32-byte random device token, base64url encoded, and its device id. The server keeps only the SHA-256 hash of that token, so a stolen roster file does not yield a usable credential.

## Device roster

The roster lives in `$DSH_HOME/remote-bridge/devices.json`, a versioned document with one row per paired device:

```json
{
  "version": 1,
  "devices": [
    {
      "deviceId": "dev_9Qm2r0Tn1Zk4",
      "pubKey": "<base64url SPKI, P-256>",
      "fingerprint": "<sha256 of the SPKI>",
      "createdAt": 1760000000000,
      "lastSeenAt": 1760000000000,
      "tokenHash": "<sha256 of the bearer token>"
    }
  ]
}
```

Nothing in that file is a usable credential in the clear: a row keeps the device's public key, its fingerprint and the SHA-256 of the token it was issued, never the token. The directory is 0700 and the file 0600; a write goes to a temporary file, is flushed and renamed into place, so a crash never leaves a half-written roster, and a file that does not parse is moved aside with a `.corrupt-<timestamp>` suffix instead of being treated as an empty roster. Protocol v1 has no revoke method, so revoking a device is removing its row (or deleting the file) and restarting the host: the roster is read once per process, and from that start on the device's connection is unpaired.

## Relay

The relay that publishes a private instance on the public internet is a full reverse proxy: it looks the instance's current tunnel target up, rewrites only the `Host` header, and returns the origin's response verbatim — the one path-specific rule is immutable caching for content-hashed `/assets/*` files. A WebSocket upgrade rides that same single hop, because the Workers runtime upgrades a `fetch` when the client sends an `Upgrade` request with a null body. Protocol v1 is therefore another path on the same origin: no Worker change, no second tunnel, no extra origin to publish.

Two consequences follow from that hop. It sees the request URL, so a `?token=` connection hands the device token to the relay, the Cloudflare edge and the origin access log — prefer the header. And `GET /remote-bridge/pair/token` is forwarded like any other path, but its loopback gate rejects the forwarded request, so pairing can only be started from the machine itself.

## Web GUI pairing panel

The browser half exists so that an operator who never opens a terminal still has a way to start pairing. It follows the family's sidebar-foot convention: the trigger registers into the official `sidebar.footer.action` list slot (declared by ui-sidebar — the seat `dsh-remote-web-ui`'s phone trigger and `dsh-update`'s updater already share) and opens a centered modal. It is delivered by the same plugin row: `exports["./client"]` is the artifact and `dsh.client` declares the client modules that must be live first.

The panel has one job — put the live one-time code in front of the operator:

- **The QR symbol encodes the bare token**: 43 base64url characters and nothing else. A URL or a JSON document would let the phone's own parser rewrite its origin onto this machine's loopback address, which is precisely the address a phone cannot reach.
- **The same token is printed in plaintext** beside the symbol, so an operator can check it by eye, and a copy action puts it on the clipboard.
- **A 30 s countdown runs** next to a **New code** action; every press mints a fresh token and voids the previous one, and an expired code says so instead of still looking scannable.
- **The origin warning is stated outright.** This page is served from `127.0.0.1:<port>`, which only this machine can reach, so the phone app's connection address has to be the public relay — such as `wss://<id>.dsh-market.com`.
- **A refusal is never silent.** The read is the same loopback-only route an operator would curl: a `403` renders as "this page is not open on this machine", and a request that never arrives renders as its own unreachable state.

The panel is display-only for the native path. It never spends the token (`pair.begin` stays the phone's call), it never touches the roster, and it adds no wire surface — the envelope, the method names, the topic names and the events are unchanged. `dsh-remote-web-ui`'s pairing service, roster and browser credential are not involved either, so the two remote surfaces keep their own access controls.

## Client script

`scripts/client.mjs` is a dependency-free protocol v1 client — Node 22 globals only, no package dependency — used to check a live bridge and to pair a test machine that has no Secure Enclave. It runs the fixed sequence once, prints every frame with its direction and numbers the events in arrival order, so a transcript can be pasted into a report; it never calls a model itself.

```sh
# check a paired connection: hello -> session.list -> session.snapshot -> session.prompt -> session.delta
BRIDGE_URL=ws://127.0.0.1:3080/ios/v1 BRIDGE_TOKEN=<deviceToken> node scripts/client.mjs

# pair this machine with a throwaway P-256 key and print the device token
node scripts/client.mjs --pair --pair-base http://127.0.0.1:3080
```

## Install

### From npm

```sh
dsh plugin --profile web add @linxin666/dsh-remote-bridge@latest
```

### From the repository

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install && pnpm -r build
dsh plugin --profile web add link:$(pwd)/packages/dsh-remote-bridge
```

The family aggregate package `@linxin666/dsh-web-all` installs this plugin together with the rest of the family. Restart `dsh web` after installing or updating — the host half registers its routes when the plugin row mounts, so the running host is what serves them — then reload the Web GUI page, which is when the browser half's sidebar-foot trigger appears.

## Configuration

The bridge is mounted like any other host plugin row. It carries no user-facing options in v1: the values in this document — the 30 s one-time bootstrap token, the loopback-only token endpoint, the 10 MiB frame cap, the fixed `/ios/v1` path — are protocol constants rather than settings. Pairing and revocation are not configuration either; they are per-device facts in the roster. The one environment fact the bridge depends on is `$DSH_HOME`, since the roster lives under it.

## Security model

- **Pairing is a full-control credential.** A paired device reaches the harness in-process: sessions, prompts, approvals. Only pair devices you control, and revoke by removing the roster row and restarting the host.
- **In-process calls speak for the owner, only behind this bridge's own gate.** Since DSH 0.2.1 the harness gateway requires every call to name the peer it speaks for, and the bridge answers with one in-process owner peer (`{kind:'owner'}`) that it mints itself at mount and attaches to every gateway call. That claim is safe because it is exercised only after the bridge's own pairing check — an unpaired connection is refused before any gateway call exists — and no field of a protocol frame can set a principal: a client that names one in its payload is ignored. The peer takes no forwarded-event interactions, so it never receives forwarded Host events either.
- **The token endpoint is loopback-only, on two conditions.** The socket address must be loopback and the `Host` header must name this machine. A tunneled request is terminated by the tunnel client on this same host, so the socket address alone reads `127.0.0.1` for a request the whole internet can reach, while the relay and a plain tunnel rewrite `Host` to the public name; failing either condition is a 403. The token is memory-only, expires in 30 s, is spent by one `pair.begin`, and the same link is written to the host log — treat that log line as a live secret.
- **The pairing panel renders a live secret and nothing more.** It reads the same loopback-gated route over a same-origin request, so it is reachable exactly where the `curl` form is, and nowhere else. It cannot mint a device token, spend one, list the roster or revoke a device: `pair.begin` stays the phone's call, and revocation stays a roster edit plus a host restart. The QR carries the bare token, so the page's own `127.0.0.1` origin is never handed to the phone.
- **An unpaired connection has a three-method whitelist.** `hello`, `pair.begin` and `pair.finish`; every other method answers `unpaired` before dispatch, so no session, approval or roster surface is reachable without a device token.
- **Device tokens are stored as hashes only.** The roster keeps the public key and its SHA-256 fingerprint, never the token, so the file is not a credential store. A lost, rotated or rejected token means pairing again — a routine flow, not an exception path (a fresh bootstrap link, or a re-scan of the desktop pairing flow), and it never requires editing the roster by hand.
- **The token comparison does not leak length.** It is a fixed-length comparison rather than an early-exit one, so a wrong token cannot be narrowed byte by byte.
- **Approvals fail closed while a client is connected.** The bridge claims a tool's permission request only while at least one paired client is connected; with none, the request goes to the next answerer rather than stalling. A claimed request that nobody answers normalizes to `unavailable`, which the harness treats as a rejection: silence from the phone is never consent.
- **The header is the safer carrier.** `Authorization: Bearer <deviceToken>` keeps the credential out of the URL; `?token=` exists for clients that cannot set handshake headers, and the relay, the edge and the access log all see a URL that authenticates as that device.

## Known limitations

- **A title belongs to a live session.** `session.titles` reads the titles of the sessions this host process holds live; the roster still lists persisted sessions that are not attached, and their ids answer `""` until the host attaches them.
- **A served title can be up to 10 s old.** One resolved title is served for 10 s before the title service is asked again, so a rename or a newly generated title can take that long to appear.
- **`archived` is absent when the archive set cannot be read.** The flag comes from the host's workspace registry; when that service is not mounted, every row omits the key instead of answering `false`.
- **`lastSeq` and `seq` are different counters.** `session.snapshot`'s `lastSeq` is the harness stream cursor; the event `seq` is this connection's own event number. They must not be compared, and resume state belongs to the client.
- **No incremental replay.** A client that detects a gap or reconnects calls `session.snapshot` again and takes the full baseline; the bridge does not buffer deltas for a disconnected client.
- **A delegated child costs one roster read per connection at the most.** A child's durable parent is only published by `session.list`, so the first child a connection opens without a prior listing pays for one roster read; every later child of any parent is free, and a client that lists before it opens pays nothing. A roster that does not name the child's parent leaves the harness's own refusal (`session/agent-busy`) crossing unchanged rather than inventing an address.
- **`session.history` cannot reach below the opening window.** Pages walk the same baseline `session.snapshot` serves, so the oldest reachable entry is the oldest entry of that window — bounded by the harness's own `maxMessages` window (200 messages). The opening frame's `hasMore` is the harness's answer about anything older, and the bridge does not fetch beyond it.
- **An entry larger than one frame cannot be made to fit.** The paged first screen and `session.history` both give such an entry a page of its own rather than refusing, so that one page can exceed the 10 MiB frame cap; every other page stays inside its budget.
- **Tool-call arguments arrive as deltas.** A `tool-call` delta may carry an empty `argumentsDelta`, and the client assembles the arguments; a whole call is never re-sent.
- **A subscription outlives an interrupt.** `session.interrupt` cancels the turn only; the subscription ends when the connection closes, and one connection aborts all of its follow streams together.
- **`clientTimeZone` is host-side.** The bridge fills it from the host's IANA zone; a client cannot pin its own zone in v1.
- **Roster edits apply on the next host start.** The roster is read once per process, so removing a device takes effect when `dsh web` restarts.
- **The panel shows one code and nothing else.** It cannot list, name or revoke paired devices, and it never spends a code — pairing happens on the phone, and revocation stays a roster edit plus a host restart.
- **The panel is only as fresh as its last read.** It reads a code when it opens and on every **New code** press; a code that expires while the panel stays open flips to the expiry state instead of silently renewing itself.
- **`scripts/client.mjs` is a check harness, not a client SDK.** It runs the fixed sequence once, keeps no state and has no reconnect logic.
