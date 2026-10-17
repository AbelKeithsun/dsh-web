# Agent Note: An official plugin update is two phases, because the manager refuses to reinstall

Status: implemented

## Problem

On the packaged Desktop client the update block's batch action failed for every third-party plugin it offered — `dsh-better-sidebar` 0.26.1 → 0.28.0, `dsh-free-search` 0.9.0 → 0.9.1, `dsh-llm-verifier` 0.9.5 → 0.10.1 — with `plugin-manager: 官方插件管理器更新失败：官方插件管理器拒绝执行（already-installed）`, and the profile kept its versions.

Three shipped facts combine into that refusal:

- `@deepseek-ai/dsh-plugin-manager` exposes only `installBundle` and `removeBundle`. There is no update primitive, and 0.2.1-rc.2 is the newest published version (npm `dist-tags`: `next = 0.2.1-rc.2`).
- Its `installBundle` opens with a guard: when the host mounts the `hmr` service and the spec's package name is already a profile dependency, it throws `ManagementFailure('already-installed')` before pnpm runs.
- `@deepseek-ai/dsh-base` mounts that service on every profile host (`id: hmr`, `disabled: !ctx.get('profileContext')`), so the guard is active wherever a profile exists — including the official Plugins page, whose own update button hands `installBundle` the `name@version` spec from `officialBundleInstallTarget`.

The update therefore had no implementation on an application-owned profile: the CLI refuses `--profile desktop` outright, and [the native writer](2026-09-26-plugin-manager-app-owned-update-path.md) is a single `installBundle` call. That path shipped before the guard existed — on 0.2.0-rc.2 pnpm really did run for `dsh-better-sidebar` 0.22.1 → 0.24.1.

## Decision

`CliGateway.update` keeps its single `installBundle` call first, and answers the `already-installed` refusal with a two-phase replacement through the same official manager:

- `nativeManagerRefusalCode()` reads the manager's failure code off the resolved verdict — the same verdict `nativeManagerFailure()` renders for the person — so the update path can branch on `already-installed` instead of matching message text.
- `replaceInstalled()` then runs `removeBundle(id)` followed by `installBundle(id@version)`. Removing first is what makes the install expressible: the guard reads the profile, so the name is a fresh dependency once the old one is gone. `removeBundle` disables the bundle and reloads before pnpm removes it, which is also what clears its `bundle-in-use` check.
- A removal the manager refuses ends the update with that refusal and no further write. A second phase that fails reinstalls the dependency spec the profile carried before the run (`id@<previous spec>`) and names both facts in the error: the refusal, and whether the old version is back or the person must reinstall by hand.
- The single call stays first so that the day upstream accepts an in-place update this path needs no change; the version verification below it is untouched, so a replacement that lands nothing is still `更新未生效`.

The official manager remains the only writer on an application-owned profile, and the CLI remains the only writer everywhere else — nothing here writes `package.json` or runs pnpm directly.

## Alternatives considered

- **Report the refusal and stop.** Rejected: the update block exists to move plugins forward, and on the desktop runtime this would leave it permanently decorative while the official page's own update button fails the same way.
- **Disable the update action when the host mounts `hmr`.** Rejected: that is every profile host, so it disables the feature everywhere to describe one missing upstream primitive.
- **Write the new dependency and run the launcher's bundled pnpm from the host half.** Rejected: a second writer of the same profile — the two would race the lock, the bundle patch application, and the reload the official manager performs around a change, and the repository's rule is that a profile has exactly one writer.
- **Ask upstream for an update primitive before fixing anything.** Rejected as the only move: the refusal is correct behavior for the guard's purpose, and no published version relaxes it, so the workaround has to exist regardless of when an update API lands.
- **Confirm with the person before the plugin is briefly uninstalled.** Rejected: the update is already a confirmed, user-initiated action with a visible job, and the rollback restores the previous version when the replacement cannot land, so an extra prompt buys risk information the job's own error report already carries.

## Consequences

- A desktop update now unloads the plugin, reloads the profile, installs the new version and reloads again — the plugin is missing between the two phases, which a client that keeps its job poll running simply sees as a normal in-flight update.
- Failure reporting is wider than before: the error names the phase that refused (`已安装版本无法移除（…）`) and, after a failed replacement, whether `id@<previous spec>` is back or the reinstall must be manual. A rollback to a range spec (`^0.9.5`) restores the dependency, not necessarily the exact bits that were installed.
- The first call is still spent on a run the current runtime always refuses, which costs no pnpm time (the guard precedes it) but does show one extra manager state in the host's install-state stream.
- Updates on every non-desktop runtime are unchanged: the CLI path never sees this guard.

## Testing

`packages/dsh-plugin-manager/tests/gateway-jobs.spec.ts` pins the three outcomes against a scripted official manager: the refusal followed by a successful removal and reinstall, the replacement failing with the previous spec reinstalled, and the removal itself refusing.
