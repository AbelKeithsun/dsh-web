# Agent Note: 替换运行时 import 门禁自维护的扫描器

Status: proposed

## Problem

运行时依赖门禁不仅维护依赖策略，还维护一个类 JavaScript 词法器。[扫描器](../../../../scripts/runtime-deps-check.mjs#L34-L137) 自持六种词法状态、带引号的说明符提取及关键字边界规则；每增加一种 JavaScript 写法都会增加仓库维护义务。它漏掉副作用 import、`import` 与 `(` 之间有注释的写法、模板表达式内的 import，以及需要解码的转义名称；正则字面量也可能被误判为 import。

## Proposal

使用同步入口 `es-module-lexer/js`，只收集解码后 `n` 为字符串的记录。明确将该包声明为根开发依赖，不依赖 pnpm 偶然暴露传递依赖。删除状态机、引号读取器和关键字匹配器。保留 `checkRuntimeImports`、依赖分类、内置及官方模块豁免、诊断和 git 跟踪产物选择规则。只有调用方仍受益时才保留小型 `importSpecifiers` 接口。

不合法的 JavaScript 应以带文件名的解析诊断使门禁失败，而不是静默产出不完整的 import 列表。计算式动态 import 和 CommonJS `require` 仍在既有静态 import 契约之外，不再造第二套解析器推断它们。

## Context & Efficiency Impact

用一项明确的开发依赖和一个小型投影，替换约 90 行项目自维护的扫描逻辑。模型/工具 schema 和提示词不变。[锁文件](../../../../pnpm-lock.yaml#L2722) 已包含 2.3.2，但[根清单](../../../../package.json#L47-L73) 未直接声明。JavaScript 入口避开 WebAssembly 初始化及异步就绪状态；依赖仍有升级和许可证维护成本。

## Evidence and ownership

- 扫描器只有一个生产消费方：[同一门禁](../../../../scripts/runtime-deps-check.mjs#L153) 中的 `checkRuntimeImports`，另有[专用测试](../../../../scripts/runtime-deps-check.test.mjs)。[CI](../../../../.github/workflows/ci.yml#L89) 和[发布工作流](../../../../.github/workflows/release.yml#L101) 会执行它；它不是交付给用户的运行时 API。
- 只读探针对已安装的同步词法器和当前扫描器进行比较：全部九份 git 跟踪的 JavaScript host/client/chunk 产物返回完全相同的有序说明符列表。独立探针复现上述漏检、正则误报以及不合法输入被拒绝。这是现有语料证据，不是对未来所有产物的证明。
- 搜索活跃的 proposed、implemented、rejected 记录未发现扫描器专属 owner。[产物门禁决策](../../implemented/process/2026-09-12-committed-lib-artifact-gate.md) 拥有源码/构建一致性而非解析规则；它继续生效。本未实施提案不取代任何记录。

## Alternatives considered

逐项修补现有扫描器的漏检：不作为首选，因为仓库仍要承担不断增长的语言实现及语法专项测试清单。

使用 TypeScript 或完整 AST 解析器：暂缓，因为门禁只需要模块说明符，根清单没有直接声明 TypeScript，完整 AST 会增加消费方不使用的机制。

保留现有扫描器：最强理由是无需新增直接依赖，并且有意容忍不合法输入。依赖政策若不接受词法器就保留；不能因为包目前是传递依赖就声称它没有成本。

## Acceptance criteria

- 增加明确且兼容的开发依赖，在受支持 Node 下限上保持可复现安装；不改应用依赖或包版本。
- 删除手写扫描器，而不是围绕库继续包一层扫描器。对当前跟踪产物保留有序说明符和既有依赖策略判定。
- 测试项目接口边界：副作用/re-export import、带注释的动态 import、模板表达式、解码转义、正则/字符串/注释干扰、import attributes、计算式动态 import、不合法输入及带文件名的诊断。
- 保留 scope 包根、内置/官方模块豁免及仅开发依赖的测试；用适配器判定测试替换语法再实现测试，不重复证明库的通用语法。
- 当前跟踪产物上的 `pnpm test:scripts`、`pnpm runtime-deps:check` 以及文档和仓库基线门禁通过。

## Risks

接受的边缘行为变化是更严格地拒绝不合法产物，以及准确发现原来跳过的写法。新诊断可能暴露已有未声明依赖，应调查原因而非把旧扫描结果设为豁免。该库是开发工具信任依赖。不得把跟踪文件边界扩展到未跟踪的陈旧构建残留。
