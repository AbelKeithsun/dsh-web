# @linxin666/dsh-agents

English | [中文](README.zh.md)

Agent squads for the DSH Web GUI: reusable member definitions (agent preset, permission, model pin, reasoning effort, member brief) whose brief joins that member session system prompt, launched as real DSH sessions by the Host.

## What it does

- A **team** is an ordered definition with a name, an optional description, an optional pinned workspace and an optional order, holding a list of members.
- A **member** is a reusable definition: display name, optional DSH agent preset id, permission, model pin, reasoning effort, and a short brief.
- A member binds a preset id rather than a prompt. The desktop profile on this machine already ships `@local/dsh-siji-research-squad`, whose presets `xundong` (寻冬), `michun` (觅春), `zhixia` (知夏) and `luoqiu` (落秋) are the user's existing research-squad presets, so the first squads need no new preset.
- The brief becomes part of **that member session's system prompt**, never the first user message; ordinary sessions are untouched, and every other assembly receives an empty section that the Host drops.
- Running a member resolves its preset through the host agent-preset registry, creates the session through the host gateway, renames it `<team name> / <member name>`, pins the permission and model route, and records a run.

## Scope of this milestone

- One member launches one session; the run record is the Host's evidence that the session exists.
- Whole-squad runs are not part of this milestone; the definition/run seam (`src/host/run-gateway.ts`) is where the official agent-team service will attach.
- Run settlement is not observed here: a launched run stays `running` until the squad service owns its outcome.

## Install

```sh
pnpm add @linxin666/dsh-agents
```

Mount the row through a profile patch; the bundle ships one host-half row named exactly after the package.

## Config

- `enabled` (default `true`): mount the ledger, the routes and the member-brief section. When off, the row registers nothing and keeps no lock.
- The ledger directory is `$DSH_HOME/dsh-agents`, resolved the way every plugin in this family resolves its own storage.

## Wire API

```text
GET  /dsh-agents/api/state
POST /dsh-agents/api/team
POST /dsh-agents/api/team/delete
POST /dsh-agents/api/member
POST /dsh-agents/api/member/delete
POST /dsh-agents/api/run
```

- The browser half drops the leading slash, exactly like the task board's prefix; M1 refreshes by polling `state` while the page is mounted.
- Failures are JSON with a stable code and one bounded sentence; no stack trace, no ledger content and no session text crosses the wire.

## Storage

- One JSON ledger at `$DSH_HOME/dsh-agents/ledger.json`, written by an fsynced temporary file plus rename, owned by one pid through `ledger.json.lock`.
- An unreadable, corrupt or foreign-generation ledger is reported and left byte-identical: this plugin never resets, quarantines or overwrites a user's definitions.

## Security model

- The route fence refuses a cross-site marker, a non-loopback socket, and a request that carries no browser same-origin signal at all.
- Ids and timestamps are minted by the Host; a draft that carries an unknown field is refused rather than merged, so a caller cannot stamp its own row.
- A member brief is user-authored text: it reaches only sessions this plugin opened for that member, and only through the system prompt.

## Known limitations

- A team must pin a workspace: an unpinned team is refused with `workspace-required` instead of running in whatever directory the Host process happens to use.
- A pinned preset must be served by the host registry; an unknown or broken preset fails closed before any session exists.
- A preset that registers a `complete` system-prompt section owns the prompt alone, and the member brief is dropped; see [docs/member-prompt.md](docs/member-prompt.md) for that exception and the fallback design.
- The reasoning effort is sent only together with the model pin it belongs to, so a member that pins an effort without a model runs at the session default.
- Run history keeps the newest 200 records; older records are dropped with the definitions they referred to.

## Tests

```sh
pnpm --filter ./packages/dsh-agents test
pnpm --filter ./packages/dsh-agents typecheck
```
