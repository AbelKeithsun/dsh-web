# Agent Note: 将受支持的 store 引擎作为普通平台外部模块

Status: proposed

## Problem

每份客户端构建都可能携带一个面向声明支持下限之外宿主的回退。共享[构建预设](../../../../shared/tsdown.client.ts#L48-L96) 拦截 `@deepseek-ai/dsh-client-store`，生成虚拟引擎模块，在解析失败后重试已退役的 `dsh-client-runtime/client`。受支持平台已经提供第一个模块，虚拟模块生命周期和第二条运行时解析分支却仍需维护。

## Proposal

在本仓退役 legacy store 引擎回退。将 `@deepseek-ai/dsh-client-store` 与 `PLATFORM_MODULES` 中其他条目同等处理：恢复为客户端 externals，删除 shim 常量、生成体以及 resolve/load 特判。闭包工厂加载器、模块表身份、浏览器纯度门、CSS 处理和可选注入规则均保持不变。受支持平台模块缺失应暴露正常加载错误，而非选择不受支持的引擎。

范围仅限本仓预设及生成产物。卫星预设由各自仓库拥有，本提案不移动其源码或 gitlink。

## Context & Efficiency Impact

删除约 45 行 shim 机制、模块解析失败分支及各 bundle 中重复的回退文本。工具 schema 和提示词组合不变。本地客户端构建可以包含 shim，但只有[市场客户端 bundle](../../../../packages/dsh-market/lib/client.js) 和[聚合客户端 bundle](../../../../packages/dsh-web-all/lib/client.js) 被 git 跟踪，不能把每份本地构建都称为已提交产物。重建输出并重新记录[指纹](../../../../scripts/lib-artifact-fingerprints.json)，不删除指纹门禁。

## Evidence and ownership

- [平台种子表](../../../../shared/web-platform.ts#L5-L17) 记录 0.2.0-rc.2 平台提供 `dsh-client-store`，并移除 `dsh-client-runtime`。本仓全部插件及聚合包清单声明 DSH engine 下限 `>=0.2.0-rc.2`，[下限不变量](../../../../scripts/family-dsh-engines.test.mjs) 保护声明。
- 值消费方包括[设置表单](../../../../shared/client/settings/settings-form.ts#L12)、[设置 scope](../../../../packages/dsh-web-settings/src/client/compat-settings-scope.ts#L22)、[lever controller](../../../../packages/dsh-liangshen/src/client/lever-controller.ts#L22)、[usage store](../../../../packages/dsh-usage/src/client/usage-store.ts#L8) 和[archive store](../../../../packages/dsh-session-archive/src/client/archive-store.ts#L8)。预设[解析器](../../../../shared/tsdown.client.ts#L264-L277) 重定向这些 import；回退不是调用方选择的功能。
- [原始 shim 决策](../../implemented/bug-fix/2026-08-28-client-store-dual-cohort-engine-shim.md) 有意支持旧宿主。之后的[宿主下限决策](../../implemented/architecture/2026-09-01-dsh-host-floor-tracks-cohort.md#alternatives-considered) 明确拒绝继续让旧宿主可安装，[rc.2 适配](../../implemented/architecture/2026-09-29-sdk-cohort-0.2.0-rc.2.md) 拥有当前 cohort。这是过期的低于下限义务，并非删除仍受支持兼容性的授权。
- 只有实施后才发生 supersession：仅退役原记录的引擎 shim 决策，不能丢弃独立的 agent-preset 桥接/注入理由。保留该 owner 并与已实施退役记录互链，不整篇合并这则混合记录。本提案本身不取代已有 owner。

## Alternatives considered

保留回退：最强理由是有意的跨 cohort 支持。如果维护者仍承诺低于宿主下限的纯客户端支持，就保留，并在实施前先澄清该承诺与下限决策的关系。

把回退移到各消费方或包内 helper：否决，因为运行时分支不消失，反而增加归属位置。

删除 store 消费方或平台纯度门：否决，因为 snapshot store 身份和浏览器安全模块解析仍是义务。普通 external 解析可以删除 shim 而不改这两项约束。

## Acceptance criteria

- 确认受支持宿主下限及不存在独立的低于下限纯客户端承诺；保留清单、公共消费方和 store 身份。
- 删除 shim 及解析特判，不以另一套兼容层替代。
- 执行 `pnpm build`、`pnpm libs:write`、`pnpm libs:check`、`pnpm runtime-deps:check` 和仓库基线门禁；检查两份跟踪客户端 bundle 及指纹。
- 重建的本仓客户端 bundle 不再包含 legacy shim id 和 `dsh-client-runtime/client` 回退，`dsh-client-store` 仍作为平台外部模块存在。
- 在真实受支持宿主上验证设置卡编辑及一个 store 驱动的客户端路径，包含卸载/重载。不能用单测代替浏览器验证声明。
- 只更新旧 owner 中被已实施退役取代的引擎事实；保留其他理由，卫星副本留待单独授权的工作。

## Risks

不受支持的旧宿主会失去自动回退。当前捕获所有 store 解析异常的路径也会遮蔽其他加载故障，普通错误将直接可见。主要正确性风险是误把第二份 store 身份内联而非 externalize。卫星仍有副本不代表本仓有权改变它们的支持契约。
