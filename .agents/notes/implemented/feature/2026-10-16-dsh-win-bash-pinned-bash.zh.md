# Agent Note: dsh-win-bash——钉摘要私有 bash 的 Windows 插件

Status: implemented

[English](2026-10-16-dsh-win-bash-pinned-bash.md) | 中文

## Problem

DeepSeek 模型的后训练以 bash 工具面为主，Windows 会话只有 pwsh 时模型会把 bash 语法打进 PowerShell，产生报错循环，浪费 token 与注意力（dsh-ops 的自报 benchmark 与该问题陈述同向；我们自己的 benchmark 尚未测过这一维度）。梁神 preset 曾自带 Git Bash（custom-bash.mjs），因无状态、无 OS 沙箱隔离、名不副实三宗罪在[梁神 shell 与分页](2026-09-17-liangshen-shell-and-paging-ptc-surface.zh.md)中退役，换回宿主持久 pwsh 栈——但该决策同时留下了「Windows 上没有真 bash」的缺口。

## Decision

缺口由一个**独立插件包**而非 preset 填充：`packages/dsh-win-bash`（npm `@linxin666/dsh-win-bash`）在 win32 x64 宿主上注册 `win_bash` 工具——每个会话一个持久的私有 bash 进程，状态跨调用保留。梁神「preset 不自带任何 shell 实现」的原则不反转：两者组合使用，互不接线。

- 载荷钉死：随包携带 Git for Windows MinGit v2.56.0.windows.2 的裁剪提取（89 个文件，15.99 MiB，含 22 份许可证文本与 PROVENANCE.md），`checksums.sha256` 记录每个文件的 SHA256，**挂载前整体验证**，摘要不符拒绝挂载；shell 只按包内绝对路径解析，绝无 PATH 回退。OpenSSH/Heimdal/OpenSSL 家族经 PE 导入分析证明无人引用后剔除。
- 工具名 `win_bash` 而非 `bash`：避免与宿主/第三方同名工具互相静默替换。行 id `dsh-win-bash`、行 name 恰好等于包名，POSIX 上 `disabled: !!js process.platform !== 'win32'`。
- 帧协议：nonce 标记的引用 heredoc 经 `.` 源入——brace 组遇语法错误会吞掉结束标记永久卡壳，heredoc 则作为单个解析单元报错后继续，实测未闭合引号的下一次调用在同一进程正常返回。stdout 取自解析后的帧而非原始流，分帧标记永不到达模型。
- 权限：策略经 `sandboxPolicy` 服务解析，受限模式经 `sandbox.confine()` 派生；受限而无 confinement provider 的部署直接拒绝，绝不裸跑。受限路径在本机（danger-full-access）只做了结构化测试，**真实 ACL 令牌下的受限探测是遗留验证项**。
- 恢复对外可见：shell 退出、超时、中止都会销毁该 shell 并在下一次调用里说明状态已丢失，绝不静默换壳；shell 随 agent disposed 与插件卸载回收。

## Alternatives considered

- 把 bash 重新做进梁神 preset。否决：2026-09-17 决策的「preset 不自带 shell」原则仍成立，独立包让宿主与 preset 都不背二进制分发面。
- 探测系统 PATH 上的 Git Bash。否决：版本与字节不可控，正是钉摘要要排除的形态（dsh-ops 同样把系统回退列为安全降级）。
- 每个命令新起进程（退役的 custom-bash.mjs 形态）。否决：无状态 shell 正是当年退役理由之一。

## Consequences

- 包首版仅 Windows x64；ARM64 与其他平台拒绝挂载（如实告警）。
- 已接入 dsh-web-all 聚合家族（聚合行 `web-ui-win-bash`，家族子路径 `@linxin666/dsh-web-all/win-bash`，`familyIds` 显式映射锁定短名），随全家桶默认安装；根 patch 不接，profile 挂载由聚合承担。打包期的「重下载钉版资产并 diff checksums」校验脚本仍为后续任务。
- **可用性跟随梁神开关**：挂载时经 `ctx.agentPresets.list()` 检查 `liangshen` 预设是否已声明，未声明即不注册 `win_bash`（绝不注册一个总会报错的工具）；`syncWithLiangShen: false` 为逃生口。门控不在 apply 里 await（注册表审计会 await 宿主 loader 树，互等即死锁），判定在挂载续延里完成，先等宿主树 settle、首读未命中再有界重读；注册表无声明变更事件，开关切换经插件管理器刷新行后生效。实现与约束见 [packages/dsh-win-bash/AGENTS.md](../../../packages/dsh-win-bash/AGENTS.md) 与 src/gate.ts 模块头。
- 宿主对未声明 `isConcurrencySafe` 的工具一律按 exclusive 调度（fail-closed），同一持久 shell 不存在并发帧竞争。
- **shell 阶梯（仅 Windows）**：win_bash 挂载成功后，宿主 pwsh 经 `agent.ctx.tools.restrict` 从各会话的模型可见面隐藏（src/pwsh-replacement.ts）——刻意只隐藏、不在执行层拒绝：刻意直调 pwsh 仍正常执行，这是阶梯的下层退路（win_bash 优先 → pwsh 承担 Windows 原生工作与 bash 失败后的兜底；本包不携带 PowerShell 载荷，该段归宿主）。`replacePwsh: false` 为并存逃生口。隐藏按 agent 作用域施加、随 agent disposed 与插件卸载逐条恢复；宿主 pwsh 行晚挂载时经 `tools/change` 补隐藏（restrict 对未知名抛错，不在场不是判定）；预占 lifts 槽位防 tools/change 自激。POSIX 为绝对 no-op（模块首行平台门，任何读取/监听/restrict 之前返回）。win_bash 的工具描述首句（目录截断窗口内）承载「Windows 命令工作优先于 pwsh」的行为指引，机制事实放在窗口外。

## Testing

- 包内 49 个测试（协议帧、注册表恢复、载荷校验、配置、挂载门控、vendored bash 实跑）；验收期间修复的四个真实缺陷（双流共享游标、帧重复解析、stdout 误读原始累加器、begin 标记未锁存）各有回归测试。
- 独立复跑：`pnpm --filter @linxin666/dsh-win-bash build/test/typecheck` 全绿；`verify-docs`、`emoji-audit`、`test-standards`、`aggregate --check`、`sync-shared --check`、`runtime-deps-check`、`family-dsh-engines` 通过；载荷 89/89 摘要核验一致，bash 实跑报告 5.3.15(2)-release。
