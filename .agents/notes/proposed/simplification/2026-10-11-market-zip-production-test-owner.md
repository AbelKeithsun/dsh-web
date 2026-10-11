# Agent Note: Test the production market ZIP writer instead of a copy

Status: proposed

## Problem

The [ZIP regression suite](../../../../scripts/market-zip.test.mjs#L12-L70) contains its own `zipStore` implementation. The [production writer](../../../../scripts/market-build#L673-L740) is separately maintained. Tests can remain green after production header offsets break because they exercise the copied implementation, not the bytes-producing owner. This is not an independent oracle: both functions implement the same serializer.

## Proposal

Move the existing pure writer to one small CommonJS helper under the script library, require it from the build, and import that same helper in the ZIP tests. Delete the test-side writer; keep the independent ZIP parsers and field/content assertions. Use Node's existing `crc32` and preserve deterministic stored-ZIP bytes, UTF-8 flags, file modes, timestamps, ordering and offsets. Add no archive dependency and no second serializer.

Keep the helper free of market scanning and top-level build execution. Update both synthetic-tree fixtures to copy it beside the build script; that is residual glue, not another implementation. No market catalog, installer, vendored shell or published API changes are required.

## Context & Efficiency Impact

One maintained serializer and its duplicate definition disappear; the production definition changes home, not behavior. The replacement costs two import sites and fixture-copy entries. Prompt/tool schema overhead is unchanged. The serializer remains repository-owned, including its current format limits; do not silently add ZIP64, compression or a general archive framework.

## Evidence and ownership

- Production [emission](../../../../scripts/market-build#L577-L585) calls `zipStore` to write per-skin downloads. The [try-on client](../../../../market/shell/packages/dsh-web-tryon/src/client.tsx#L239) links to those shipped ZIPs. This is production machinery, not a test-only helper.
- The test explicitly says it inlines the same writer to avoid importing a non-module script. Its independent [header parsers](../../../../scripts/market-zip.test.mjs#L72-L129) and seven structural/content scenarios should remain; only the copied producer is removed.
- The [clean-checkout fixture](../../../../scripts/market-build-clean.test.mjs#L37-L65) already copies a sibling script. The [capacity fixture](../../../../scripts/market-build-cap.test.mjs#L26-L50) currently copies only the build script and needs the new helper too. These are real consumers of script packaging, not reasons to leave the duplicate.
- Active proposed/implemented/rejected searches found no owning ZIP-writer note or overlapping proposal. No existing record is superseded. A separate [archive comparison exclusion](../../../../scripts/market-build#L876-L887) skips ZIPs when the shell build is absent; its intent is not established, so changing it is explicitly outside this proposal.

## Alternatives considered

Keep the copied writer and add an equality gate: rejected because this maintains two definitions plus a synchronization rule. One imported implementation removes that obligation.

Extract the function text with regex/eval in the test: rejected because tests would depend on source spelling and still not exercise the production packaging boundary.

Export the function from the entire build script and guard `main`: possible, but not preferred because importing it still executes module-scope path/asset resolution. A small pure helper isolates the actual contract at the cost of two fixture-copy entries.

Keep the copy unchanged: the strongest reason is a self-contained fixture build. That advantage does not justify a false regression guarantee; sibling-file packaging is already part of the clean-fixture contract.

## Acceptance criteria

- Production build and ZIP tests consume the same writer; no copied serializer or source-extraction adapter remains.
- Preserve exact output bytes for representative empty, multi-file, binary and UTF-8 archives; preserve independent decoding and extraction assertions.
- A temporary offset defect introduced in the production helper must fail the owning ZIP regression suite; revert the defect before committing.
- Both synthetic-tree fixtures work with the helper packaged beside the build script; `pnpm test:scripts` and repository baseline gates pass.
- `pnpm market:check` passes with pinned inputs, and a full implementation build leaves committed archive bytes unchanged. No unrelated regenerated market output enters the commit.
- Keep the archive-comparison exclusion unchanged unless a separate evidence-backed decision establishes its removal.

## Risks

A missing helper in a copied-script fixture or deployment breaks execution before the writer runs. Moving imports carelessly can execute the whole market build during a unit test. The independent parsers are the oracle and must not be replaced by assertions generated from the same writer logic.
