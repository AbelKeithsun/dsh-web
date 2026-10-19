# Agent Note: A forwarding header makes a reverse-proxied request remote

Status: implemented

## Problem

A dsh deployment is commonly put behind a reverse proxy: a Cloudflare tunnel, frp, or an nginx reverse proxy that terminates the public connection and dials the host at `127.0.0.1:<port>`. Such a hop produces exactly the shape both halves of the loopback classification ask for, on a request that came from the public internet:

- the origin's socket peer is the proxy, which connects over loopback, so `request.socket.remoteAddress` is `127.0.0.1`;
- the proxy rewrites the `Host` header to its own upstream literal (`127.0.0.1:<port>`, or `localhost:<port>`), so the Host half holds too.

Both facts are individually true and jointly worthless: the request was never local. The shared fence (`isLoopbackRequest`) and this repository's own control-plane predicate (`packages/dsh-remote-web-ui/src/gate.ts` `isLoopbackClient`) returned true, so `makeGateListener` delegated without a device cookie, and the loopback-only pairing control planes (mint, stop, revoke, the device roster, the events stream) served an unauthenticated public caller. The desktop-only status view (`/api/pair/status`) answered that caller with the loopback snapshot as well.

The signal that separates the two situations is the forwarding header the proxy itself stamps: `CF-Connecting-IP` and `X-Forwarded-For` exist only because a hop forwarded the request. Issue #1906 records the report.

## Decision

A request that carries `CF-Connecting-IP` or `X-Forwarded-For` is never classified as loopback.

- The rule lives once, in `shared/host/loopback.ts`: `isProxiedRequest` reports either header as present, and `isLoopbackRequest` refuses such a request before it reads the Host. Every package that fences its host routes on `isLoopbackRequest` (ssh, git-graph, market, plugin-manager, session-archive, skill-explorer, task-board, task-board-github, usage, update) therefore inherits the rule through its generated copy, refreshed by `node scripts/sync-shared.mjs`.
- `isLoopbackClient` in `packages/dsh-remote-web-ui/src/gate.ts` applies the same rule. That predicate guards the `api/gate` listener, the `/api/pair` control planes and the desktop-only pairing snapshot, so one change covers all of them rather than each route growing its own check.
- The rule keys on the header's presence, not its value. A proxy that forwards an empty or spoofable value still marks the request as forwarded, and a caller-supplied value is never read as evidence of anything. This is also why the accept rate limiter's existing use of the edge-appended `X-Forwarded-For` hop is untouched: that code already reads the header only for loopback-peered requests, which are now exactly the forwarded ones, and it never grants access.
- The browser same-origin markers (`sec-fetch-site`, `Origin`) keep their place and their order: a cross-site marker still refuses the request first, and a matching Origin is still required where it was required before. A real desktop request - loopback socket, loopback Host, no forwarding header - classifies as local exactly as it did.

## What the rule cannot see

The rule is a header test, and a reverse proxy is configurable. Three residuals are deliberate and stated in the package README security model rather than hidden:

- A proxy configured to drop both headers puts the request back into the same shape as the desktop, which no header-level rule can separate. Cloudflare and nginx forward `X-Forwarded-For` by default; a hand-written nginx `proxy_set_header` block that omits it, or clears it with an empty value, does not.
- A process on this machine can forge any header, exactly as it could already forge the `Origin` a local tool sends. Nothing about the local trust model changes: the desktop still needs no credential.
- The desktop shell's own re-issue service and this package's loopback proxy (`loopback-proxy.ts`) do not forward forwarding headers, so neither is newly fenced by this rule.

## Alternatives considered

Refusing a loopback Host altogether was rejected: the desktop is served from `127.0.0.1`, and a Host-based ban would take the local application down with the proxy case.

Keeping a trusted-proxy allowlist (only the configured proxies may mark a request forwarded) was rejected as the wrong default for a security fix. It is a configuration surface that fails open when unset, and the deployments that need the fix are exactly the ones that were never configured; presence of a forwarding header fails closed.

Normalizing the effective client address from `X-Forwarded-For` and classifying that instead was rejected: the value is caller-supplied unless the number of trusted hops is known, and a wrong count re-establishes the same bypass with extra steps. The decision this note implements is the one the issue settled - a forwarding header means not local - and it needs no knowledge of the topology.

Fixing only `gate.ts` was rejected for the same reason the shared fence exists: ten sibling packages fence on `isLoopbackRequest`, and a fix in one of them would leave the same bypass in the rest.

## Consequences

- A deployment behind a reverse proxy no longer gets loopback treatment: the pairing control planes refuse it (403), and the status view answers it as an unpaired LAN caller instead of handing out the desktop snapshot. That is the intended outcome of the fix and a visible behavior change for anyone who had been using the bypass as a convenience.
- The pairing channel and the browser half are unaffected: a paired device reaches `/remote` through the normalized Host it presented, and the tunnel landing flow keeps working because it never claimed loopback.
- The tunnel path this repository instruments itself is not affected: the accept limiter already buckets forwarded requests by the edge-appended hop, and `x-forwarded-proto` still only decides cookie security.
- Every copy of `loopback.ts` in the tree changes at once, because the file is generated; `pnpm test:scripts` fails on any copy that is not re-synced.

## Testing

- `shared/tests/loopback.spec.ts` (17 tests) covers the four required shapes: loopback socket with loopback Host and no forwarding header is still local; either forwarding header makes it remote; a non-loopback socket stays remote; and the empty-value case, which must not be read as "no proxy". It also pins the browser markers, including that they still decide on their own for a direct request.
- `packages/dsh-remote-web-ui/tests/gate.spec.ts` (21 tests) pins the same four shapes on `isLoopbackClient`, plus the gate decision itself: a forwarded request that looks loopback is refused without a device cookie.
- `packages/dsh-remote-web-ui/tests/routes.spec.ts` (42 tests) runs the real route family over a real HTTP server: `/api/pair/issue` and `/api/pair/stop` answer 403 for a request with `CF-Connecting-IP` or `X-Forwarded-For` while the direct call still answers 200, and `/api/pair/status` refuses the forwarded caller instead of returning the loopback snapshot.
- Repository gates: `pnpm -r test`, `pnpm typecheck`, `pnpm test:scripts` (which carries the sync drift gate), `pnpm test:standards`, `pnpm i18n:check`, `pnpm emoji:check` and `node scripts/verify-docs.mjs` are green with the change.
