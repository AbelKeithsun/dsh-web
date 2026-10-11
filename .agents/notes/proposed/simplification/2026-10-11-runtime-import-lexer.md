# Agent Note: Replace the maintained runtime-import scanner

Status: proposed

## Problem

The runtime dependency gate maintains a JavaScript-like lexer rather than just the dependency policy. Its [scanner](../../../../scripts/runtime-deps-check.mjs#L34-L137) owns six lexical states, quoted-specifier extraction and keyword-boundary rules. Every additional JavaScript form becomes repository maintenance. It misses side-effect imports, comments between `import` and `(`, imports inside template expressions and decoded escaped names; a regular-expression literal can be mistaken for an import.

## Proposal

Use the synchronous `es-module-lexer/js` entry and collect records whose decoded `n` is a string. Declare the package explicitly as a root dev dependency; do not depend on pnpm exposing a transitive package. Delete the state machine, quote reader and keyword matcher. Keep `checkRuntimeImports`, dependency classification, builtin/official-module exemptions, diagnostics and git-tracked artifact selection. Retain the small `importSpecifiers` seam only if its callers still benefit from it.

Malformed JavaScript will fail the gate with a file-specific parse diagnostic rather than silently produce a partial import list. Computed dynamic imports and CommonJS `require` remain outside the existing static-import contract; do not invent a second parser to infer them.

## Context & Efficiency Impact

This removes roughly 90 lines of project-owned scanning machinery in exchange for one explicit development dependency and a small projection. It changes no model/tool schema or prompt. Version 2.3.2 already occurs in the [lockfile](../../../../pnpm-lock.yaml#L2722), but the [root manifest](../../../../package.json#L47-L73) does not declare it. The JavaScript entry avoids WebAssembly initialization and asynchronous readiness state; the dependency still carries an update/license obligation.

## Evidence and ownership

- The scanner has one production consumer, `checkRuntimeImports`, in the [same gate](../../../../scripts/runtime-deps-check.mjs#L153), plus the [dedicated tests](../../../../scripts/runtime-deps-check.test.mjs). The [CI workflow](../../../../.github/workflows/ci.yml#L89) and [release workflow](../../../../.github/workflows/release.yml#L101) execute it; it is not a shipped runtime API.
- A read-only probe of the installed synchronous lexer and the current scanner produced identical ordered specifier lists for all nine git-tracked JavaScript host/client/chunk artifacts. Separate probes reproduced the missed forms above, the regex false positive and malformed-input refusal. This is corpus evidence, not proof for every future artifact.
- Search of active proposed, implemented and rejected notes found no scanner-specific owner. The [artifact gate decision](../../implemented/process/2026-09-12-committed-lib-artifact-gate.md) owns source/build consistency, not parsing. It remains in force; no record is superseded by this unimplemented proposal.

## Alternatives considered

Patch each missed form in the existing scanner: rejected as the preferred direction because the repository would retain a growing language implementation and its grammar-specific test inventory.

Use TypeScript or a complete AST parser: deferred because this gate needs only module specifiers, the root does not directly declare TypeScript, and a full AST adds machinery the consumer does not use.

Keep the current scanner: its strongest advantage is zero additional direct dependency and deliberately forgiving malformed input. Retain it if the dependency policy rejects the lexer; do not claim a package is cost-free just because it is currently transitive.

## Acceptance criteria

- Add an explicit compatible dev dependency and keep installation reproducible at the supported Node floor; no application dependency or package version changes.
- Remove the hand-written scanner rather than wrapping it around the library. Keep ordered specifiers and existing dependency-policy verdicts for current tracked bundles.
- Test project-specific cases: side-effect/re-export imports, commented dynamic import, template expression, decoded escape, regex/string/comment decoys, import attributes, computed dynamic import and malformed input with a filename diagnostic.
- Retain tests for scoped package roots, builtin/official exemptions and dev-only dependencies; replace grammar-reimplementation tests with adapter verdict tests rather than re-proving the library grammar.
- Pass `pnpm test:scripts` and `pnpm runtime-deps:check` on current tracked artifacts, plus the documentation and repository baseline gates.

## Risks

The accepted edge change is stricter malformed-artifact handling and accurate detection of forms previously skipped. New findings can expose existing undeclared dependencies; investigate them instead of grandfathering the old scanner output. The library is a dev-tool trust dependency. Do not expand the tracked-file boundary to stale untracked build leftovers.
