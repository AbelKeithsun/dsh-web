# AGENTS.md - dsh-win-bash

DSH web GUI 插件 dsh-win-bash。包级规则：只写本包特有约定，不重复根 AGENTS.md 与
packages/AGENTS.md 的全局/包级规则。

## 本包要点

- **host-only 包**：只有 `src/index.ts`（host 半区）与 `src/shell.ts`、`src/tool.ts`、
  `src/protocol.ts`、`src/runtime.ts`、`src/config.ts`、`src/gate.ts`。没有 `src/client/`，
  因此 `shared/tsdown.client.ts` 自动跳过浏览器 bundle；`dsh.client` 不声明。
- **可用性门控跟随梁神预设声明**（`src/gate.ts`）：挂载时向 agent-preset 注册表
  查询是否声明了 id `liangshen` 的预设，未声明即不注册工具（绝不注册一个总会报错
  的工具），`syncWithLiangShen: false` 为逃生口。门控读的是注册表的公开 `list()`
  （定义名册，含激活失败的条目），不依赖该 SDK 包——只用结构化镜像，签名依据写在
  `gate.ts` 模块头。
- **门控不得从 apply 里 await**：注册表的 `list()` 会对每个已声明预设做审计，必要时
  await 宿主 loader 树（`diagnostic` → `loader.await()`），而当前行的激活本身正是那棵树
  在等的任务，两边互等即死锁。因此 `apply` 同步返回，判定在 `mountWithGate` 的续延里
  完成；fiber 在判定期间被销毁就不再注册。注册表关闭时不挂声明变更事件（它只声明
  `agent-preset/selected`，那是单会话的持久日志事件，与名册无关），开关切换经插件管理器
  刷新行后生效。
- **门控的两段等待都有上限**：先 `settleHostTree` 等宿主 loader 树（同一组内的行并发挂载，
  不能假设梁神行先跑完），再读名册；首读未命中则按 `GATE_POLL_INTERVAL_MS` 在
  `GATE_DECLARATION_WAIT_MS` 内重读——声明方插件在自己的激活返回之后才发布预设，两者
  先后不固定，迟到的声明不能被判成拒绝。两段都有界，任何一段超时都不挂死宿主启动。
  `GateOptions` 是测试缩减这些时限的唯一入口，不要在测试里用真实秒级等待。
- **工具名固定 `win_bash`，行 id 固定 `dsh-win-bash`**，且行的 `name` 恰好等于包名。
  改名会撞上宿主自带的 `bash`/`pwsh` 行，或让 loader 静默丢弃同行 id 的其它行
  （见 packages/AGENTS.md 的行 id 纪律）。
- **随包载荷不许回退**：shell 只从 `runtime/win32-x64` 里按绝对路径解析，绝不查 `PATH`。
  任何「顺手用系统 Git 的 bash」的改动都违反本包存在的理由。
- **载荷完整性是挂载前置条件**：工具注册之前先跑 `resolveRuntime`（校验整份
  `checksums.sha256`）；改载荷必须重算清单，否则挂载会被拒绝。
  `PROVENANCE.md` 是载荷的唯一事实源（上游 URL、摘要、裁剪规则、许可证对照）。
- **帧协议改动必须带协议单测**：`src/protocol.ts` 的 heredoc 框架决定了「命令语法错误不会
  卡死 shell」这一核心保证；`tests/protocol.spec.ts` 的 fixture 必须按 bash 实际写出的字节构造。
- **恢复策略对外可见**：shell 退出、超时、中止都会销毁该 shell，且必须在下一次调用的结果或错误里
  说明状态已丢失；不得静默换壳。

## 提交前检查

```sh
pnpm --filter @linxin666/dsh-win-bash typecheck
pnpm --filter @linxin666/dsh-win-bash test
pnpm --filter @linxin666/dsh-win-bash build
```
