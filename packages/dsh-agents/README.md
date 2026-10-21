# @linxin666/dsh-agents

English | [中文](README.zh.md)

Agent squads for the DSH Web GUI: reusable member definitions (agent preset, permission, model pin, reasoning effort, member brief) whose brief joins that member session system prompt, launched as real DSH sessions by the Host.

## What it does

- A **team** is an ordered definition with a name, an optional description, an optional pinned workspace and an optional order, holding a list of members.
- A **member** is a reusable definition: display name, optional DSH agent preset id, permission, model pin, reasoning effort, and a short brief.
- A member binds a preset id rather than a prompt. The desktop profile on this machine already ships `@local/dsh-siji-research-squad`, whose presets `xundong` (寻冬), `michun` (觅春), `zhixia` (知夏) and `luoqiu` (落秋) are the user's existing research-squad presets, so the first squads need no new preset.
- The brief becomes part of **that member session's system prompt**, never the first user message; ordinary sessions are untouched, and every other assembly receives an empty section that the Host drops.
- Running a member resolves its preset through the host agent-preset registry, creates the session through the host gateway, renames it `<team name> / <member name>`, pins the permission and model route, and records a run.

## Agent Teams runtime

- Running the whole squad is one action on the squad page: an optional goal and an optional Lead preset. The goal travels on the run request; the Lead preset is a field of the squad (`TeamDefinition.leadPreset`), so that choice survives the request, the page reload and the next device instead of dying with one run.
- The Lead preset picker offers only the ids `GET /state` reports under `presets`, and a preset the registry marks unusable is not offered. A deployment whose preset registry is absent or failing omits the field, and so does a registry with nothing usable left in it; the page then states the squad's own pin rather than an empty list.
- The launch order is the contract: the team's pinned workspace is validated, the Lead preset is resolved against the registry before any session exists, the session is renamed `<team name> / Lead`, and the squad run record is written before the first message is queued, so the Lead's own first assembly already knows which squad it leads.
- The Lead's model-facing tools spawn one teammate per member. Each teammate is composed from its member definition's pins: the preset is resolved before the child session exists, and the permission and model route are applied before the teammate's first prompt is checkpointed. A pin this deployment cannot honour fails that spawn with a named error instead of running the member as the deployment default.
- The squad roster and the goal reach the Lead as a `team:squad` system-prompt **context**, not a section, so a member preset that declares a `complete` section cannot drop them.
- The live team view reads the forked runtime's `agentTeam` session projection (`stateVersion` 4) out of the shared client session store: the Lead, every teammate it spawned, each row's role and phase, and the failure text of a member that never started. While that projection answers, the page polls nothing.
- Team tools install only into sessions this Host started as a squad run. An ordinary session - everyday chat, an ordinary coordinator turn - sees no Team tool and keeps the native subagent tools, which this package never disables.
- Run history covers both kinds: squad runs with their Lead session and goal, and member runs with their member name and their open-session action, newest first and capped at the 200 records the Host keeps.
- The page turns every failure into one sentence: a transport failure reads as not-mounted, unauthorized, forbidden, timeout, unreachable or unexpected; a Host refusal keeps its own class for unknown-preset, no-workspace, squad-missing, lead-create-failed, lead-prepare-failed and ledger-unavailable; every other code reads as a plain rejection quoting the Host's bounded sentence.
- Run settlement is not observed here: a launched run stays `running` until a later milestone owns its outcome.

Each of those deltas, and the exact upstream baseline it departs from, is recorded in [docs/fork-provenance.md](docs/fork-provenance.md) and [docs/runtime-deltas.md](docs/runtime-deltas.md); both are maintainer contracts, not suggestions.

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
POST /dsh-agents/api/squad/run
```

- The browser half drops the leading slash, exactly like the task board's prefix, and refreshes by polling `state` while the page is mounted.
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
