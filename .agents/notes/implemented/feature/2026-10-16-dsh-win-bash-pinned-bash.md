# Agent Note: dsh-win-bash — a pinned private bash as a Windows plugin

Status: implemented

English | [中文](2026-10-16-dsh-win-bash-pinned-bash.zh.md)

## Problem

DeepSeek models are post-trained primarily against a bash tool surface; a Windows session that only has pwsh sees the model push bash syntax into PowerShell, producing error loops that burn tokens and attention (dsh-ops' self-reported benchmark points the same way; our own benchmark has not measured this dimension yet). The liangshen preset once shipped its own Git Bash (custom-bash.mjs), retired in [liangshen shell and paging](2026-09-17-liangshen-shell-and-paging-ptc-surface.md) for being stateless, unconfined, and bash in name only — but that decision also left a "no real bash on Windows" gap.

## Decision

The gap is filled by an **independent plugin package**, not the preset: `packages/dsh-win-bash` (npm `@linxin666/dsh-win-bash`) registers the `win_bash` tool on win32 x64 hosts — one persistent private bash process per session, state kept across calls. Liangshen's "a preset ships no shell implementation" principle stands unreversed: the two compose and never wire into each other.

- Pinned payload: a curated extraction of Git for Windows MinGit v2.56.0.windows.2 ships in the package (89 files, 15.99 MiB, 22 license texts and PROVENANCE.md); `checksums.sha256` records every file's SHA256 and the **whole payload is verified before mount** — a mismatch refuses the mount; the shell resolves only by absolute path inside the package, never PATH. The OpenSSH/Heimdal/OpenSSL family is excluded after PE-import analysis proved nothing kept references it.
- The tool is named `win_bash`, not `bash`: a same-named tool would silently replace or be replaced by the host's. Row id `dsh-win-bash`, row name exactly the package name, `disabled: !!js process.platform !== 'win32'` on POSIX.
- Framing: a nonce-marked quoted heredoc sourced via `.` — a brace group aborts on a syntax error and would swallow the end marker, wedging the shell forever; a heredoc parses as one unit, so an unterminated quote is reported and the next call succeeds on the same process (measured). stdout comes from the parsed frame, never the raw accumulator, so framing never reaches the model.
- Permissions: policy resolves through the `sandboxPolicy` service; confined modes spawn through `sandbox.confine()`; a confined deployment without a confinement provider is refused rather than run unconfined. The confined path is only structurally tested on this machine (danger-full-access) — **a real ACL-token probe of confined mode is a follow-up verification item**.
- Recovery is visible: an exited, timed-out or aborted shell is destroyed and the next call states that state was lost; shells are released on agent disposal and plugin unload.

## Alternatives considered

- Putting bash back into the liangshen preset. Rejected: the 2026-09-17 "a preset ships no shell" principle still holds, and an independent package keeps the binary-distribution surface off both host and preset.
- Probing the system Git Bash on PATH. Rejected: version and bytes are uncontrollable, which is exactly the shape pinning exists to exclude (dsh-ops likewise lists system fallback as a security downgrade).
- Spawning a fresh process per command (the retired custom-bash.mjs shape). Rejected: a stateless shell was one of the original reasons for retirement.

## Consequences

- v1 ships Windows x64 only; ARM64 and other platforms refuse the mount with an honest warning.
- Wired into the dsh-web-all aggregate family (aggregate row `web-ui-win-bash`, family subpath `@linxin666/dsh-web-all/win-bash`, locked by an explicit `familyIds` mapping), so it installs with the family by default; the root patch stays untouched. A packaging-time script that re-downloads the pinned asset and diffs it against checksums remains a follow-up.
- **Availability follows the LiangShen switch**: at mount the gate checks `ctx.agentPresets.list()` for a declared `liangshen` preset and registers no `win_bash` without it (never a tool whose every call refuses); `syncWithLiangShen: false` is the escape hatch. The gate never awaits from apply (the registry audit awaits the host loader tree, and mutual waiting deadlocks), so the verdict lands in a continuation after the host tree settles, with a bounded re-read when the first roster read misses; the registry exposes no declaration-change event, so a switch toggle takes effect through the plugin manager's row refresh. See [packages/dsh-win-bash/AGENTS.md](../../../packages/dsh-win-bash/AGENTS.md) and the src/gate.ts module header for the constraints.
- The host schedules tools without `isConcurrencySafe` as exclusive (fail-closed), so one persistent shell never faces concurrent frames.
- **Shell ladder (Windows only)**: once win_bash registers, the host pwsh is withdrawn from every served session's model-facing surface via `agent.ctx.tools.restrict` (src/pwsh-replacement.ts) — deliberately visibility-only with no execution denial: a deliberate pwsh call still runs, which is the ladder's lower rung (win_bash first; pwsh carries Windows-native work and the fallback after win_bash failures; this package ships no PowerShell payload, that rung stays the host's). `replacePwsh: false` keeps both shells listed. Restrictions are per-agent, lifted on agent disposal and plugin unload; a host pwsh row that mounts later is hidden through `tools/change` (restrict throws on unknown names, so absence is not a verdict); the lifts slot is pre-claimed to stop `tools/change` self-recursion. POSIX is a total no-op (the platform gate is the module's first line, before any read, listener, or restrict). The win_bash description's first sentence — inside the catalog truncation window — carries the "prefer over pwsh" guidance, while the mechanism fact sits beyond the window.

## Testing

- 49 package tests (framing protocol, registry recovery, payload verification, config, mount gating, vendored-bash live runs); the four real defects found during acceptance (shared cursor across streams, frame re-parse, stdout read from the raw accumulator, unlatched begin marker) each carry a regression test.
- Independent reruns: `pnpm --filter @linxin666/dsh-win-bash build/test/typecheck` all green; `verify-docs`, `emoji-audit`, `test-standards`, `aggregate --check`, `sync-shared --check`, `runtime-deps-check`, `family-dsh-engines` pass; all 89 payload checksums verified and the vendored bash reports 5.3.15(2)-release.
