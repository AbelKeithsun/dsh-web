# Agent Note: Git Graph branch chip sits in the hero chip group

Status: implemented

## Problem

In blank sessions, the Git branch selector (`BranchChip`) detached and floated high above the conversation area / hero whale illustration rather than sitting in the row alongside `WorkspaceChip` and `AgentPresetSeat`.

The root cause was that `BranchChip` calculated `top = rowRect.top - stackRect.top + ...` (coordinates relative to `div.wSkVaW_composerStack`) and applied `position: absolute; left: ${left}px; top: ${top}px` (`css.anchorHero`). However, `composerStack` and `heroWorkspaceRow` are `position: static` flex containers without an established containing block; the nearest positioned ancestor establishing a containing block was `div.wSkVaW_body` at the top of the conversation view (`y = 0`). As a result, calculating coordinates relative to `composerStack` (centered vertically) but positioning relative to `body` caused the chip to jump hundreds of pixels above the composer card and hero row.

Portaling the chip into `heroWorkspaceRow` directly fixed the detachment but parked it at the row's trailing edge: the row's last child is the right-aligned `conversation.hero.options` box (`.heroOptions { margin-left: auto }`), so an appended child lands beyond it, next to the row's right padding, instead of continuing the leading chip group (workspace, agent preset).

## Decision

`BranchChip` no longer computes coordinates and never appends itself to the row. In the blank hero phase it portals into a **dedicated seat cell** it inserts itself, positioned right after the agent-preset seat and before the right-aligned options box.

1. **DOM target resolution**: `findHeroRow(anchor)` resolves the connected element matching `.heroWorkspaceRow` (either `outlet.previousElementSibling` or inside `composerStack`).
2. **Seat cell**: `heroSeatOf(heroRow)` reuses an existing `[data-gitgraph-hero-seat]` direct child, otherwise creates one (`display: inline-flex; align-items: center`) and inserts it with `after()` on the element it follows: the `[data-slot="conversation.hero.agentPreset"]` outlet when that outlet is a direct child, else the `.heroOptions` box, else the row's last child.
3. **Portaling**: When `heroSeat` is active and the cell resolved, `createPortal(chipNode, seat)` renders the chip inside it. A hidden zero-dimension placeholder remains in `conversation.input.dock`.
4. **Flex flow**: `.anchorHero` uses `display: inline-flex; align-items: center;` without `position: absolute;`. The chip participates naturally as a flex child of the row, inheriting the official 2px gap, vertical alignment, and responsive flow with no coordinate calculations or resize observers.
5. **Re-insertion and cleanup**: the cell lives outside React's tree (the official children re-render through `renderSlot` outlets), so a `MutationObserver` on the row re-creates it when React drops it; unmount removes the cell.

## Alternatives considered

- **Portal straight into the row (previous implementation)**: React renders the row's official children, so an imperatively appended node lands after every one of them — past the right-aligned `.heroOptions` box — and is also dropped whenever those children re-render.
- **Calculate coordinates against `anchor.offsetParent`**: Fragile across scrolling, viewport resizes, dynamic composer loading, and varying parent containing block styles across skins.
- **Translate transform on dock container**: Dock outlet sits below the hero row, so negative transforms break flex boundaries and create collision risks with composer card elements.
- **Moving to `conversation.input.right`**: that slot renders inside the composer card's tool row, not in the hero chip row above the card; it would not preserve the selector-row placement.

## Consequences

- The Git branch chip continues the row's leading chip group (workspace, agent preset, branch) with the row's native spacing, in every skin that restyles `.heroWorkspaceRow`.
- Eliminates animation frames, `ResizeObserver` loops, and coordinate math.
- The client bundle was rebuilt for `@linxin666/dsh-client-ui-git-graph` and re-inlined into `@linxin666/dsh-web-all`.

## Testing

- Unit tests in `packages/dsh-git-graph/tests/client.spec.tsx` cover the seat cell position (after the preset outlet, before the options box) and its removal on unmount; all 13 test files (184 tests) in `dsh-git-graph` pass.
- Real Web GUI verification at `http://127.0.0.1:3080`: the hero row's child order is workspace chip, `conversation.hero.workspace`, `conversation.hero.agentPreset`, the `data-gitgraph-hero-seat` cell, `heroOptions`; the chip renders directly beside the preset chip.
- Repository-wide `pnpm typecheck`, `pnpm test`, `pnpm docs:check`, and `pnpm i18n:check` pass.
