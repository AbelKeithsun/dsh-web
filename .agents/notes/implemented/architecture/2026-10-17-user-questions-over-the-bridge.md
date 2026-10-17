# Agent Note: Carry the host's questions over the bridge

Status: implemented

## Problem

The remote bridge could not carry `ask_user_question`. The host has had a question service for a while (`ctx.userQuestions`, with a `user-questions/request` waterfall and a `userQuestions` projection), but protocol v1 only exposed `approval.resolve`, which is one tool approval with its own silence-is-refusal rule. A question raised while a phone was connected therefore reached nobody on the phone: the client had no event to render and no method to answer with.

## Decision

- A new capability, `questions.v1`, carries a `question.request` event and a `question.answer` method. Capability-gated exactly like `session.snapshot.page.v1`: a client that does not declare it receives no such event and is refused with `unknown-method`, so its behaviour is unchanged byte for byte.
- The bridge claims the host's `user-questions/request` waterfall in-process, mirroring the existing `approval/request` claim. It claims only while at least one paired client is connected, and it withdraws the claim and calls `next()` when the broadcast reaches no client that declared the capability, so a host answer is never held by a bridge nobody is listening to.
- The claimed request settles differently by state. An `open` question is settled by resolving the waterfall promise the bridge is holding. A `continued` question is forwarded to the host's `answer` remote method, which only accepts continued questions — it looks the call up in `continued(agent)` and returns `false` otherwise, so the open half cannot use it.
- `callId` on the wire is an opaque handle. A timed ask brings the host's real `ToolCallId` in `wait.callId`; a blocking ask brings none, so the bridge mints `bridge:<base64url>`. Without that, every blocking `ask_user_question` — the tool as it is actually declared, with no `timeout` parameter — would be delegated away and no phone would ever see a question.
- An unknown `callId` or a `sessionId` mismatch, and a host refusal that means the question is no longer addressable, are reported as `question-unknown`. Host errors pass through unchanged; the code table stays open.
- The bridge invents no deadline. A timed ask keeps the host's own deadline and becomes `continued` on `ASK_TIMED_OUT`; a blocking ask has no deadline at all and stays `open` until it is answered, the last client leaves, or the bridge is disposed.

## Alternatives considered

- **Only claim asks that carry `wait.callId`** (the first implementation). The host type has `wait` optional and only `askTimed` fills it, and the real tool schema declares no `timeout`, so this delegated every genuine question away and made the channel useless for the case it exists for. Rejected.
- **Forward every answer to the host's `answer` method.** That method resolves only continued questions; an open question would fail every time. Rejected.
- **Reuse `approval.resolve` for answers.** It carries a different decision vocabulary and a two-minute silence rule that must not leak onto questions, and the host does not recognise the ids. Rejected.
- **Recompute the questions from session events locally** instead of claiming the waterfall. That would give the bridge a second source of truth for a fact the host already owns, and the projection exists for exactly this. Rejected.
- **Add a local timeout for blocking asks.** The host has none for them; a bridge-invented deadline would fabricate a refusal the user never gave. Rejected.

## Consequences

- A paired phone can now display a pending question and answer it, including one that has already moved to `continued`, where the answer is steered back to the agent as a new turn.
- A blocking question has no deadline, so an unanswered one stays claimable indefinitely. That is the host's own semantics, and the event carries no `expiresAt` because the bridge does not read the host's wait stream yet.
- Verification: the package suite runs 226 tests across 21 files and `pnpm typecheck` is clean. The claim, the minted id, the open/continued split, the `question-unknown` cases, host error pass-through, the withdraw-on-last-client rule and the legacy-client path all have cases.
- Not verified here: an end-to-end run against a real host process. `@deepseek-ai/dsh-user-questions` does not resolve from this package, so the claim is driven by a waterfall-shaped double and the types are declared locally. The round trip needs one manual confirmation.
- The desktop profile resolves this package from `dsh-web/.pinned/dsh-remote-bridge`, a copy rather than the checkout, so rebuilding `packages/dsh-remote-bridge` alone changes nothing the running host can see: copy `lib/` into the pinned package and restart the host. Recorded because it cost a false start on the first device test.