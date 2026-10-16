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
- No aggregate or root-patch wiring yet: dsh-web-all integration and profile mounting are follow-up tasks, as is a packaging-time script that re-downloads the pinned asset and diffs it against checksums.
- The host schedules tools without `isConcurrencySafe` as exclusive (fail-closed), so one persistent shell never faces concurrent frames.

## Testing

- 49 package tests (framing protocol, registry recovery, payload verification, config, mount gating, vendored-bash live runs); the four real defects found during acceptance (shared cursor across streams, frame re-parse, stdout read from the raw accumulator, unlatched begin marker) each carry a regression test.
- Independent reruns: `pnpm --filter @linxin666/dsh-win-bash build/test/typecheck` all green; `verify-docs`, `emoji-audit`, `test-standards`, `aggregate --check`, `sync-shared --check`, `runtime-deps-check`, `family-dsh-engines` pass; all 89 payload checksums verified and the vendored bash reports 5.3.15(2)-release.
