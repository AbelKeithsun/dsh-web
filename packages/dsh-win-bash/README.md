# @linxin666/dsh-win-bash

English | [中文](README.zh.md)

A pinned, private bash for Windows x64 DSH sessions. The plugin ships its own
Git for Windows MinGit payload, keeps one persistent bash process per session
behind the `win_bash` tool, and never falls back to a bash found on `PATH`.

## Why

Models write shell commands in bash syntax - pipelines, `$VAR`, single
quotes, here-documents - and a Windows session whose only shell is PowerShell
answers many of them with a syntax error. Each error costs a round trip and
teaches the model nothing about the right dialect. This package removes that
loop by giving the session a real MSYS2 bash whose version and bytes are
pinned, so the dialect the model writes is the dialect that runs.

The shell is persistent because shell work is stateful: a command that `cd`s
or exports a variable expects the next command to see it. One process per
session is what makes that true.

## What it does

- Registers ONE model-facing tool, `win_bash`. The name is deliberately not
  `bash`: the host already mounts its own bash-family tools, and sharing a
  name would replace or be replaced, silently either way.
- Keeps one persistent `bash -s` process per calling session. The working
  directory, exported variables, functions, aliases and shell history survive
  across calls for that session and belong to no other session.
- Runs each call as a foreground command with bounded stdout and stderr,
  separated streams, and the command's real exit code.
- Verifies the vendored payload against its SHA256 manifest before the tool is
  registered at all; a mismatch refuses the mount.
- Replaces the host's own `pwsh` tool on the session's model-facing surface
  while `win_bash` is registered, so command work goes to bash instead of to
  the shell a model already knows. See [Which shell to use](#which-shell-to-use).

It adds no settings section, no HTTP route and no browser half: the Host
renders this row's configuration form from the plugin's own Config schema.

## Which shell to use

The preference this plugin installs is a ladder, and it is a Windows ladder:

1. **`win_bash`** for command work. It is the pinned MSYS2 bash, its state
   survives across calls, and the dialect a model writes for it is the dialect
   that runs.
2. **`pwsh`** for the Windows-native work only PowerShell does - cmdlets, the
   registry, Windows services - and as the fallback when a command is not bash.
   The Host resolves it, so a machine with PowerShell 7 installed gets `pwsh`
   and one without gets the Windows PowerShell the platform ships. This package
   carries no PowerShell payload of its own.

While `win_bash` is registered, this plugin withdraws `pwsh` from the
session's tool surface, which is what makes the first rung stick: a model that
can see both shells picks the one it already knows, and nothing in a tool
schema outvotes that habit. The effect is exactly that - a session with one
listed shell - so the mnemonic the `win_bash` description carries is
"hides it rather than forbidding it".

- **Visibility only.** A `pwsh` call a model makes deliberately still runs.
  There is no execution guard and no pre-execute denial: withdrawing the
  fallback rung outright would trade a preference for a capability loss.
- **Per session, never process-wide.** The withdrawal is a scoped tool
  restriction on the sessions this plugin serves. Anything else in the same
  deployment keeps the surface it composed.
- **Only while `win_bash` is actually mounted.** A refused availability gate,
  a payload that fails verification, a non-Windows host, or a row with
  `replacePwsh: false` leaves `pwsh` exactly where it was. Withdrawing the
  only usable shell of a deployment that ends up with no replacement shell
  would leave the session with neither.
- **Windows only.** On POSIX the host shell is bash, win_bash does not mount,
  and this logic produces no restriction, no listener and no effect at all.
- **Reversible.** Every restriction is lifted when its session is disposed and
  when the plugin unloads, one isolated callback at a time.

Set `replacePwsh: false` to list both shells side by side and advertise the
preference with the tool description alone.

## Availability

The tool serves sessions that run the LiangShen (梁神) agent preset, so its
availability follows that preset's **declaration**. At mount the plugin asks the
harness's agent-preset registry whether a preset with id `liangshen` is
declared; when it is, the tool registers, and when it is not, no tool is
registered at all and one info line states the reason. A tool that mounted and
refused every call would teach the model a capability the session does not have,
which is worse than an honest absence.

Three verdicts are distinguishable in the log, because they need different
actions: the preset is declared (registered), no such preset is declared (enable
the `dsh-liangshen` plugin row), and no usable agent-preset registry is
published in this deployment. Setting `syncWithLiangShen: false` skips the gate
entirely and always registers the tool.

The verdict waits for the host plugin tree to settle and then reads the roster.
A read that already carries the declaration decides at once; one that does not is
re-read on a short bounded schedule, because the declaring plugin publishes its
preset off its own activation return and the two can therefore land in either
order. A late declaration is never turned into a refusal.

The registry declares no roster-change event, so the verdict is decided once per
mount. Toggling the LiangShen row takes effect for `win_bash` after the plugin
manager refreshes the profile — the same freshness model the rest of the family
uses, not an immediate one.

## Install

### From the repository (development)

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install
pnpm --filter @linxin666/dsh-win-bash build
dsh plugin --profile web add link:$(pwd)/packages/dsh-win-bash
```

The bundle patch marks this package's row disabled on every non-Windows host,
so a POSIX profile can carry the same composition without mounting anything.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | 300000 | Whole-call wall-clock limit in milliseconds (1000..3600000). On expiry the shell is stopped and the next call starts a fresh one. |
| `maxStdoutBytes` | 131072 | Visible stdout byte budget (1024..1048576). Output past it is dropped from the front and the result is flagged truncated. |
| `maxStderrBytes` | 32768 | Visible stderr byte budget (1024..524288). |
| `description` | built-in | Model-facing tool description; deployments may describe their own environment. |
| `syncWithLiangShen` | true | When true, the tool registers only while the `liangshen` agent preset is declared; false skips that gate and always registers. |
| `replacePwsh` | true | While this tool is registered, withdraw the host's `pwsh` tool from each session's model-facing surface. Visibility only: a deliberate `pwsh` call still runs. False lists both shells. |

## Tool interface

| Parameter | Required | Meaning |
| --- | --- | --- |
| `command` | yes | The bash command to run, any number of lines. |
| `workdir` | no | Working directory for this command. Omitted keeps the shell's current directory. |
| `timeoutMs` | no | Per-call limit, clamped to the configured ceiling. |

The result carries `stdout`, `stderr`, the command's `exitCode`, and the
sandbox facts for the call.

## Permissions

The tool resolves the session's effective sandbox policy from the same
sandbox-policy service the host's own enforcing families use. Under a
confined mode the shell's argv goes through the sandbox provider's `confine` step
before it is spawned, and a composition that reports a confined mode without
a usable provider is refused rather than quietly run unconfined.

This tool offers no per-call escalation argument.

## Payload

The vendored runtime comes from Git for Windows `v2.56.0.windows.2` (the
official upstream release), reduced to the shell, its userland and its exact
DLL closure. Two assets of that release supply it: the MinGit archive
`MinGit-2.56.0.2-64-bit.zip` carries everything except `usr/bin/sleep.exe` and
`usr/bin/seq.exe`, which MinGit does not ship at all and which come from the
same release's full `Git-2.56.0.2-64-bit.tar.bz2`. Every file is registered in
`runtime/win32-x64/checksums.sha256` and every redistributed component's license
text ships beside it. [PROVENANCE.md](PROVENANCE.md) records both source URLs and
digests, the curation rules, the payload inventory and the license mapping.

## Known limitations

- Windows x64 only. The payload is a Windows MSYS2 build and the tool refuses
  to substitute a bash from `PATH` on any other platform or architecture.
- No ssh client is vendored. The MinGit tree's OpenSSH family is deliberately
  excluded; use the session's own tools for remote work.
- One shell per session, and the session's shell dies with it. A shell that
  exits or wedges is replaced on the next call, and that call says so.
- A command that prints past the visible budget loses the front of its output.
  The tail is what is kept, and the result says it was cut.

## Follow-up work

- A packaging-time verification script that re-downloads the pinned source
  assets, rebuilds the payload and diffs the result against `checksums.sha256`,
  so a payload refresh is machine-checked rather than hand-reviewed.

## License

Apache-2.0 for this package's own source. The vendored payload keeps its own
licenses (GPL-2.0-or-later and GPL-3.0-or-later among others); see
[PROVENANCE.md](PROVENANCE.md).
