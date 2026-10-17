# Agent Note: Git Graph 分支 chip 归位到 hero 胶囊组

Status: implemented

## Problem

在空白会话中，Git 分支选择器（`BranchChip`）发生脱落，漂浮在对话区和空白鲸鱼插画上方，未能与 `WorkspaceChip` 和 `AgentPresetSeat` 并排处于同一行。

根因是 `BranchChip` 通过 `top = rowRect.top - stackRect.top + ...`（相对 `div.wSkVaW_composerStack` 的坐标）计算位置并应用了 `position: absolute; left: ${left}px; top: ${top}px`（`css.anchorHero`）。然而，`composerStack` 和 `heroWorkspaceRow` 的定位都是 `position: static` 的 flex 容器，并未建立 containing block；最近的定位祖先是对话视图顶部的 `div.wSkVaW_body`（`y = 0`）。因此，相对垂直居中的 `composerStack` 计算的坐标在相对 `body` 定位时导致 chip 跳到 composer 卡片和 hero 行上方数百像素处。

把 chip 直接 portal 进 `heroWorkspaceRow` 修复了脱落，但把它推到了行尾：该行最后一个子节点是右对齐的 `conversation.hero.options` 盒子（`.heroOptions { margin-left: auto }`），被追加的子节点会落到它之后、行右侧内边距处，而不是延续前导胶囊组（工作区、智能体预设）。

## Decision

`BranchChip` 不再计算坐标，也不再把自己追加到行尾。空白会话 hero 阶段，它 portal 进一个**专属 seat 单元格**；该单元格由插件自行插入，位于智能体预设席位之后、右对齐选项盒之前。

1. **DOM 目标解析**：`findHeroRow(anchor)` 解析匹配 `.heroWorkspaceRow` 的已连接元素（`outlet.previousElementSibling` 或 `composerStack` 内部）。
2. **Seat 单元格**：`heroSeatOf(heroRow)` 复用已存在的直接子节点 `[data-gitgraph-hero-seat]`；不存在则创建一个（`display: inline-flex; align-items: center`），并用 `after()` 插到参照元素之后：`[data-slot="conversation.hero.agentPreset"]` 是直接子节点时用它，否则用 `.heroOptions` 盒子，再否则用行的最后一个子节点。
3. **Portal 挂载**：`heroSeat` 激活且单元格已解析时，`createPortal(chipNode, seat)` 把 chip 渲染进该单元格。`conversation.input.dock` 中保留隐藏的零尺寸占位符。
4. **Flex 流布局**：`.anchorHero` 使用 `display: inline-flex; align-items: center;`，不带 `position: absolute;`。Chip 作为行的原生 flex 子节点自然排列，继承官方 2px 间距、垂直居中与响应式流，无需坐标计算或 resize observer。
5. **重插与清理**：单元格在 React 树之外（官方子节点经 `renderSlot` 重新渲染），因此行上的 `MutationObserver` 在 React 丢掉它时重建；卸载时移除该单元格。

## Alternatives considered

- **直接 portal 进行（上一版实现）**：行的官方子节点由 React 渲染，命令式追加的节点必然排在其后——越过右对齐的 `.heroOptions` 盒子——并且在这些子节点重渲染时会被丢掉。
- **针对 `anchor.offsetParent` 计算坐标**：在滚动、视口缩放、动态加载 composer 以及不同皮肤的父级 containing block 样式差异下十分脆弱。
- **对 dock 容器施加 translate 变换**：Dock outlet 位于 hero 行下方，负向 translate 会破坏 flex 边界并引发与 composer 卡片元素的碰撞风险。
- **改挂 `conversation.input.right`**：该槽位渲染在 composer 卡片内部工具行，而不是卡片上方的 hero 胶囊行，无法保持选择器行的位置。

## Consequences

- Git 分支 chip 延续行的前导胶囊组（工作区、智能体预设、分支），在所有重绘 `.heroWorkspaceRow` 的皮肤下都保持该行的原生间距。
- 消除了动画帧调度、`ResizeObserver` 循环与像素坐标计算。
- `@linxin666/dsh-client-ui-git-graph` 客户端 bundle 已重建，并重新内联进 `@linxin666/dsh-web-all`。

## Testing

- `packages/dsh-git-graph/tests/client.spec.tsx` 覆盖 seat 单元格的位置（在预设席位之后、选项盒之前）与卸载移除；`dsh-git-graph` 的 13 个测试文件（184 个测试）全部通过。
- 真实 Web GUI 验证（`http://127.0.0.1:3080`）：hero 行的子节点顺序为 工作区胶囊、`conversation.hero.workspace`、`conversation.hero.agentPreset`、`data-gitgraph-hero-seat` 单元格、`heroOptions`；分支 chip 紧贴预设胶囊右侧渲染。
- 仓库级 `pnpm typecheck`、`pnpm test`、`pnpm docs:check`、`pnpm i18n:check` 全部通过。
