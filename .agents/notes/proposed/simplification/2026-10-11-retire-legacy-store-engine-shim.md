# Agent Note: Use the supported store engine as a normal platform external

Status: proposed

## Problem

Every client build can emit a fallback for a host cohort below the declared support floor. The shared [build preset](../../../../shared/tsdown.client.ts#L48-L96) intercepts `@deepseek-ai/dsh-client-store`, emits a virtual engine module, catches resolution failure and retries the retired `dsh-client-runtime/client` module. This keeps a virtual-module lifecycle and a second runtime-resolution branch alive after the supported platform supplies the first module.

## Proposal

Retire the legacy store-engine fallback in this repository. Treat `@deepseek-ai/dsh-client-store` like the other entries in `PLATFORM_MODULES`: restore it to client externals and remove the shim constants, generated shim body and resolve/load special cases. Keep the closure-factory loader, module-table identity, browser purity gate, CSS handling and optional injection rules unchanged. A missing supported platform module must surface the normal loader error, not select an unsupported engine.

This is bounded to the in-repository preset and generated artifacts. Satellite presets belong to their own repositories; neither their sources nor gitlinks move as part of this proposal.

## Context & Efficiency Impact

The change removes about 45 lines of shim machinery, its module-resolution failure branch and duplicated emitted fallback text. It does not change tool schemas or prompt composition. Locally built clients can contain the shim, but only the [market client bundle](../../../../packages/dsh-market/lib/client.js) and [aggregate client bundle](../../../../packages/dsh-web-all/lib/client.js) are git-tracked; do not describe every local build as a committed artifact. Rebuild outputs and re-record [fingerprints](../../../../scripts/lib-artifact-fingerprints.json), do not delete the fingerprint gate.

## Evidence and ownership

- The [platform seed table](../../../../shared/web-platform.ts#L5-L17) documents the 0.2.0-rc.2 platform supplying `dsh-client-store` and removal of `dsh-client-runtime`. Every in-repository plugin and aggregate manifest declares a DSH engine floor of `>=0.2.0-rc.2`; the [floor invariant](../../../../scripts/family-dsh-engines.test.mjs) protects declarations.
- Value consumers include [settings form](../../../../shared/client/settings/settings-form.ts#L12), [settings scope](../../../../packages/dsh-web-settings/src/client/compat-settings-scope.ts#L22), [lever controller](../../../../packages/dsh-liangshen/src/client/lever-controller.ts#L22), [usage store](../../../../packages/dsh-usage/src/client/usage-store.ts#L8) and [archive store](../../../../packages/dsh-session-archive/src/client/archive-store.ts#L8). The preset [resolver](../../../../shared/tsdown.client.ts#L264-L277) redirects these imports; the fallback is not a caller-selected feature.
- The [original shim decision](../../implemented/bug-fix/2026-08-28-client-store-dual-cohort-engine-shim.md) deliberately served old hosts. The later [host-floor decision](../../implemented/architecture/2026-09-01-dsh-host-floor-tracks-cohort.md#alternatives-considered) explicitly rejects keeping older hosts installable, and the [rc.2 adaptation](../../implemented/architecture/2026-09-29-sdk-cohort-0.2.0-rc.2.md) owns the current cohort. This is an expired below-floor obligation, not permission to erase still-supported compatibility.
- Supersession is conditional on implementation: retire only the original note's engine-shim decision, not its distinct agent-preset bridge/injection rationale. Keep that owner and cross-link the implemented retirement rather than consolidating the whole mixed note. No existing owner is superseded by this proposal alone.

## Alternatives considered

Keep the fallback: strongest reason is its deliberate cross-cohort support. Retain it if maintainers still promise below-floor client-only support despite the host-floor decision; resolve that promise before implementation.

Move the fallback into every consumer or a package-local helper: rejected because that preserves the same runtime branch and increases ownership sites.

Remove store consumers or the platform-purity gate: rejected because snapshot-store identity and browser-safe module resolution remain required. Ordinary external resolution removes the shim without changing either obligation.

## Acceptance criteria

- Confirm the supported host floor and no separate below-floor client-only promise; preserve manifests, public consumers and store identity.
- Delete the shim and special-case resolution rather than replacing them with another compatibility layer.
- Run `pnpm build`, `pnpm libs:write`, `pnpm libs:check`, `pnpm runtime-deps:check` and the repository baseline gates; review both tracked client bundles and fingerprints.
- In rebuilt in-repository client bundles, the legacy shim id and `dsh-client-runtime/client` fallback disappear while `dsh-client-store` remains a platform external.
- Exercise settings-card editing and a store-driven client path against a real supported host, including unload/reload. Do not claim browser validation from unit tests alone.
- Update the old owning note only where the implemented retirement supersedes its engine facts; retain its other rationale and leave satellite copies to separately authorized work.

## Risks

An unsupported old host loses automatic fallback. Catching every store-resolution error currently also masks other loader failures; normal errors will become visible. The principal correctness risk is accidentally bundling a second store identity instead of externalizing it. Satellite copies are not evidence that this repository can change their support contracts.
