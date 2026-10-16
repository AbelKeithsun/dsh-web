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

It adds no settings section, no HTTP route and no browser half: the Host
renders this row's configuration form from the plugin's own Config schema.

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

The vendored runtime is Git for Windows MinGit `v2.56.0.windows.2` (the official
upstream release, `MinGit-2.56.0.2-64-bit.zip`), reduced to the shell, its
userland and its exact DLL closure. Every file is registered in
`runtime/win32-x64/checksums.sha256` and every redistributed component's license
text ships beside it. [PROVENANCE.md](PROVENANCE.md) records the upstream URL,
the source zip digest, the curation rules, the payload inventory and the
license mapping.

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

- Aggregate wiring: this package is deliberately NOT a child of the `dsh-web-all`
  aggregate yet, and the root `cordis.patch.yml` is untouched.
- A packaging-time verification script that re-downloads the pinned MinGit
  asset, rebuilds the payload and diffs the result against `checksums.sha256`,
  so a payload refresh is machine-checked rather than hand-reviewed.

## License

Apache-2.0 for this package's own source. The vendored payload keeps its own
licenses (GPL-2.0-or-later and GPL-3.0-or-later among others); see
[PROVENANCE.md](PROVENANCE.md).
