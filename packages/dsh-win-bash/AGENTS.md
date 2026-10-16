# AGENTS.md - dsh-win-bash

DSH web GUI 插件 dsh-win-bash。包级规则：只写本包特有约定，不重复根 AGENTS.md 与
packages/AGENTS.md 的全局/包级规则。

## 本包要点

- **host-only 包**：只有 `src/index.ts`（host 半区）与 `src/shell.ts`、`src/tool.ts`、
  `src/protocol.ts`、`src/runtime.ts`、`src/config.ts`。没有 `src/client/`，因此
  `shared/tsdown.client.ts` 自动跳过浏览器 bundle；`dsh.client` 不声明。
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
