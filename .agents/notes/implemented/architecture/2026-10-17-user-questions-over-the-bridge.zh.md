# Agent Note: 把宿主的提问搬过桥

Status: implemented

## Problem

远端桥此前搬不动 `ask_user_question`。宿主早就有提问服务（`ctx.userQuestions`，带 `user-questions/request` waterfall 与 `userQuestions` 投影），但协议 v1 只暴露了 `approval.resolve`——那是单次工具审批，还带着「沉默视为拒绝」的规则。于是手机连着桥的时候，宿主提出的问题在手机上没有任何去处：客户端既没有可渲染的事件，也没有可作答的方法。

## Decision

- 新增能力 `questions.v1`，承载 `question.request` 事件与 `question.answer` 方法。门控方式与 `session.snapshot.page.v1` 一致：不声明能力的客户端收不到该事件，调用该方法会拿到 `unknown-method`，行为逐字节不变。
- 桥照既有 `approval/request` 的写法，在进程内认领宿主的 `user-questions/request` waterfall。它只在至少有一个已配对客户端在线时认领；广播没有送达任何声明了能力的客户端时，立刻撤回认领并 `next()`，以免一个没人听的桥把宿主的等待占住。
- 认领之后，两种状态分两条落地路径：`open` 由桥结算自己持有的 waterfall promise；`continued` 转调宿主的 `answer` 远程方法——那个方法只接受 continued 问题（在 `continued(agent)` 里找不到就返回 `false`），所以 open 那一半用不了它。
- 线路上的 `callId` 是 opaque 句柄。timed 提问带宿主的真实 `ToolCallId`（`wait.callId`）；阻塞式提问没有，由桥铸造 `bridge:<base64url>`。不这样做的话，每一个阻塞式 `ask_user_question`（也就是实际声明的那个工具，没有 `timeout` 参数）都会被让位出去，手机上永远看不到提问。
- 未知 `callId`、`sessionId` 不符，以及「问题已不可寻址」的宿主拒绝，统一报 `question-unknown`；宿主错误原样穿过，码表保持开放。
- 桥不发明 deadline。timed 提问沿用宿主的 deadline，`ASK_TIMED_OUT` 后转 `continued`；阻塞式提问根本没有 deadline，一直 `open`，直到有人作答、最后一个客户端离开或桥被卸载。

## Alternatives considered

- **只认领带 `wait.callId` 的提问**（第一版实现）。宿主类型里 `wait` 是可选、只有 `askTimed` 才填，而真实工具 schema 又不声明 `timeout`，结果把所有真实提问都让位出去，通道对它唯一存在的场景完全失效。否决。
- **把每个回答都转调宿主的 `answer`**。该方法只结算 continued 问题，open 态会次次失败。否决。
- **复用 `approval.resolve` 作答**。它带不同的决策词汇与「沉默两分钟视为拒绝」的规则，那条规则不能漏到提问上；而且宿主根本不认这些 id。否决。
- **本地从 session 事件重算问题**，不认领 waterfall。那会让桥对宿主已经拥有的事实建第二个真相源，而投影本来就是为这件事存在的。否决。
- **给阻塞式提问加本地超时**。宿主对它没有 deadline；桥自造的 deadline 等于伪造一次用户从未给出的拒绝。否决。

## Consequences

- 已配对的手机现在可以显示待答问题并作答，包括已经转成 `continued` 的——那种回答会作为新一轮 steer 回给 agent。
- 阻塞式提问没有 deadline，没人回答就一直可答。这是宿主自己的语义；事件暂不带 `expiresAt`，因为桥还没有读宿主的等待流。
- 验证：本包 21 个测试文件、226 个用例全绿，`pnpm typecheck` 干净。认领、铸造 id、open/continued 分流、`question-unknown` 各分支、宿主错误穿透、最后一个客户端离开即让位、以及 legacy 客户端路径都有用例。
- 这里未验证：对真宿主进程的端到端。`@deepseek-ai/dsh-user-questions` 在本包无法 resolve，认领是用 waterfall 形状的替身驱动的，类型也本地声明。这条往返需要一次人工确认。
- 桌面 profile 解析这个包走的是 `dsh-web/.pinned/dsh-remote-bridge` 那份拷贝，而不是 checkout，所以只重建 `packages/dsh-remote-bridge` 对运行中的宿主不产生任何影响：要把 `lib/` 同步进 pinned 副本再重启宿主。记下来是因为它让第一次真机验证白跑了一趟。
- 监听器用 `prepend` 注册：宿主的 waterfall 是先答者得，桌面客户端自己的应答者会在本桥被咨询之前就把每个提问认领走（在监听器入口写诊断证明过它从未执行）。**当有声明了该能力的手机在线时，桌面面板被刻意不启动**：桥能结算宿主那次 ask，却无法关掉宿主 UI 自己打开的面板，启动了就会在手机已经作答之后留下一张不消失的卡。手机不在线、以及认领被撤回时，仍然交给链上其余应答者。