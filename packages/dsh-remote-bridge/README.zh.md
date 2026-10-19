# dsh-remote-bridge · DeepSeek Harness (DSH) 协议 v1 宿主适配包

[English](README.md) | 中文

<p align="center">
  <img src="https://img.shields.io/npm/v/@linxin666/dsh-remote-bridge?style=flat-square" alt="Version">
  &nbsp;
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-4c6ef5?style=flat-square&amp;labelColor=454a54" alt="DSH">
  &nbsp;
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License">
</p>

把 DeepSeek Harness（DSH）本体发布成协议 v1 的宿主侧适配包：一个 `/ios/v1` 的 WebSocket 面，原生客户端（手机 App、平板、终端脚本）无需浏览器、无需 Web GUI 包体、也无需改动中继即可驱动它。

协议 v1 是有意独立于浏览器路径的第二条面：配对设备 cookie 与受门禁的 `/remote` 通道属于 `dsh-remote-web-ui`，本包不回放那份凭据。它在同一进程内消费宿主——会话工作走 Typert gateway，权限请求走审批瀑布——并自行签发一次性 bootstrap token，不改动 `dsh-remote-web-ui` 的配对服务面。

## 功能

本包发布一套协议，并在它旁边提供一个很小的浏览器面。宿主半区发布的是一套协议：

- **一个面。** 宿主 WebServer 上以精确路径注册的 `/ios/v1` WebSocket；帧为文本帧，一帧一个 JSON 对象，单帧上限 10 MiB（10485760 字节）。
- **会话面。** `session.list`、`session.titles`、`session.snapshot`、`session.prompt`、`session.interrupt` 分别覆盖带工作区、谱系与归档元数据的名册、一批会话标题、完整基线加实时订阅、带幂等键的排队发言，以及回合取消。
- **agent 面。** `presets.list` 转发宿主的 Agent 预设名册，`session.create` 转发一次创建请求，手机因此能像桌面一样从预设实例化一个 Agent；这两个身体在桥里都不被解释。
- **fork 面。** `session.fork` 把一条会话分叉成继承它上下文的新会话；切点与新会话的身份都属于宿主，因此请求与回包逐字穿过。
- **订阅而非轮询。** `session.snapshot` 打开宿主的 follow 流并保持它，基线与其后的每一条增量都走同一条 socket。
- **审批直达客户端，重连的手机还能拿回仍悬着的那些。** 需要授权的工具以 `approval.request` 事件到达，客户端用 `approval.resolve` 作答；无人应答的请求按拒绝处理，而声明了 `approvals.v1` 的连接会在握手之后再次收到所有未结算的审批。
- **配对。** 一次性 bootstrap token 加 P-256 挑战应答产出可吊销的设备令牌；未配对连接只能触达三个方法。
- **一个配对面板。** 同一插件行声明 `dsh.client` 浏览器半区：侧栏底部一个面板，把当前的一次性配对码同时以二维码与明文呈现给操作者，配 30 秒倒计时与「重新取码」。
- **中继无需改动。** 协议搭在实例本来就发布的那个 origin 上，中继这一跳照原样转发它，与其他所有请求无异。

## 传输

| 帧 | 形状 |
| --- | --- |
| 请求 | `{"t":"req","id":<uint>,"m":"<method>","p":{...}}` |
| 响应 | `{"t":"res","id":<uint>,"ok":true,"r":{...}}` 或 `{"t":"res","id":<uint>,"ok":false,"e":{"code":"<str>","msg":"<str>"}}` |
| 事件 | `{"t":"ev","seq":<uint>,"m":"<topic>","p":{...}}` |
| 心跳 | `{"t":"ping","ts":<ms>}` 与 `{"t":"pong","ts":<ms>}` |

`seq` 属于每个连接，自 1 起单调递增：它给的是该连接收到的事件序号，不是宿主自身的历史。帧为文本帧、一帧一个 JSON 对象、单帧上限 10 MiB（10485760 字节）。空闲连接每 20 秒探活一次；客户端以 pong 回应 ping，桥接侧同样如此。

## 方法集

| 方法 | 请求 `p` | 响应 `r` |
| --- | --- | --- |
| `hello` | `{proto:1, minor:8, client:"ios/0.1", cap:["session.snapshot.trim.v1","subagent.thread.v1"]}` | `{proto:1, minor:8, server:"dsh-remote-bridge", capabilities:["session.snapshot.trim.v1","session.snapshot.page.v1","questions.v1","subagent.thread.v1","jobs.v1","agents.v1","delta.v1","session.list.omit-archived.v1","session.deep-history.v1","session.fork.v1"], resume:"snapshot", auth:"paired" 或 "unpaired"}` |
| `session.list` | `{}` | `{sessions:[{id, title, updatedAt, agentRunning, cwd?, parentSessionId?, origin?, blank, archived?}]}` |
| `session.titles` | `{ids:[<sessionId>, ...]}` | `{titles:{"<id>":"<title>", ...}}` |
| `session.snapshot` | `{sessionId, maxBytes?}` | `{turns:[...], lastSeq:<uint>, hasMore?}` |
| `session.history` | `{sessionId, before?, maxBytes?}` | `{turns:[...], nextBefore?:<uint>, hasMore:<bool>}` |
| `session.history.deep` | `{sessionId, before?, maxBytes?}` | `{turns:[...], nextBefore?:<uint>, hasMore:<bool>}` |
| `session.prompt` | `{sessionId, text, requestId}` | `{accepted:true}` |
| `session.interrupt` | `{sessionId}` | `{ok:true}` |
| `presets.list` | `{}` | 宿主 `agentPresets/list` 的身体，逐字转发 |
| `session.create` | 宿主自己的 `SessionCreateRequest` | 宿主 `session/create` 的身体，逐字转发 |
| `session.fork` | `{sessionId, atSeq?}` | 宿主 `session/fork` 的身体（`SessionForkValue`），逐字转发 |
| `pair.begin` | `{token}` | `{nonce, expiresAt}` |
| `pair.finish` | `{devicePubKey, signature}` | `{deviceToken, deviceId}` |
| `approval.resolve` | `{id, decision}` | `{ok:true}` |

`hello` 无需设备令牌即可调用，并回报本连接自身的 `auth` 状态。`session.snapshot` 把宿主 follow 流的开帧快照映射成 `turns`，把它的 cursor 作为 `lastSeq` 回报，随后保持该流作为本连接对该会话的订阅；`session.prompt` 幂等地确保同一条订阅，因此客户端可以跳过 snapshot。发言模式固定为排队，`clientTimeZone` 由服务端填本机 IANA 时区，`requestId` 是幂等键：同名 `requestId` 在同一会话内只发一次，重复调用直接回 `{accepted:true}` 且不再发送。`session.interrupt` 取消回合，不拆除订阅。

agent 的两个方法什么都不解释。`presets.list` 把宿主 `agentPresets/list` 的身体原样回给客户端——该端点不收请求，所以一行预设就是注册表发布的东西，连它的插件清单一起——`session.create` 把客户端的身体作为该端点唯一的 `request` 参数送出，再把宿主自己的回包原样回给客户端。字段名、默认值与拒绝码都属于宿主：客户端对着宿主自己的 `SessionCreateRequest` 校验创建请求，而不是对着桥里留的一份副本；宿主拒绝时它拿到的是宿主的 `code` 与 `msg`——没有错误码的失败以本桥的 `internal` 穿出，但消息仍是宿主的原文。两个方法只对声明了 `agents.v1` 的客户端存在：没声明时各自回 `unknown-method`，且什么都不发；声明了却从不调用，则宿主一次读取都不会发生。

fork 的方法同样什么都不解释。`session.fork` 把 `sessionId` 与客户端真的点名时才有的 `atSeq`（fork 包含的源事件 seq）作为该端点唯一的 `request` 参数送出，再把宿主自己的 `SessionForkValue` 原样回给客户端。省略的 `atSeq` 就保持省略：宿主把缺席的切点读成最新一个已完成轮，在这里补一个等于悄悄挪动切点。不是正整数的切点在这里以 `invalid-args` 拒绝，因为任何事件日志都没有这样的 seq；宿主拒绝的请求带着宿主自己的 `code` 与 `msg` 穿出，没有错误码的失败以本桥的 `internal` 穿出。该方法只对声明了 `session.fork.v1` 的客户端存在：没声明时回 `unknown-method`，且什么都不发。

`hello` 还携带客户端的能力声明，而能力是公告而非协商：无论 `cap` 里是什么，握手都回同一个帧，未知名字被忽略；单帧上限在两个方向上都是同一个常量——约束接收帧的 10 MiB，同时也是拟合快照、以及丢弃超限出站事件的同一份预算。本桥自己服务十个能力，并在 `hello` 的 `capabilities` 里公告它们：`session.snapshot.trim.v1`、`session.snapshot.page.v1`、`questions.v1`、`subagent.thread.v1`、`jobs.v1`、`agents.v1`、`delta.v1`、`session.list.omit-archived.v1`、`session.deep-history.v1`、`session.fork.v1`——插件注册的能力不在其中，因为桥不是它的作者。`approvals.v1` 也不在其中，它由客户端声明、本桥刻意从不公告：它门控的是一次重放而不是通道本身，因此握手对每个客户端都是同一个帧（见下文审批通道）。第一个就是裁剪基线。未声明它的客户端——包括该能力出现之前写下的所有客户端——拿到的基线与协议 v1 一直以来提供的逐字节一致。声明了它的客户端拿到的是裁剪过的基线：每个回合内部只保留它能渲染的 entry（`user/message`、`assistant/message`、`tool/call`、`tool/result`、`subagent/catalog`），宿主自己的记账记录（`system/message`、`request/header` 之类）在量帧大小之前就被剔除。快照的其余部分不变：保留哪些回合、它们的顺序，以及每个回合的 `seq`、`endSeq`、`reason`、`time` 都是投影自己的取值；一个回合的 entry 若全是记账记录，该回合仍保留为 `entries` 为空的回合；`lastSeq` 仍是宿主游标。帧预算在其后生效——先裁 entry，再丢最旧的整回合，仍然装不下才回 `snapshot-too-large`。

第二个能力 `session.snapshot.page.v1` 给首屏本身加上页预算。不声明时，一次快照仍是整个开帧窗口，逐字节与今天一致。声明之后，`session.snapshot` 只回最新一页，按 `maxBytes`（默认 524288，即 512 KiB；不是可用预算就拒绝，而不是悄悄夹取）衡量，并用 `session.history` 那同一套按 entry 的切片来切：一个回合的 entry 可以跨在这一页与下一页之间，而该回合保留自己的字段；比整页预算还大的单条 entry 独占一页；`snapshot-too-large` 再也不会回给这样的连接。这一页带 `lastSeq` 与 `hasMore`，而它继续往回的游标就是它自己最旧那条 entry 的 `seq`——正是 `session.history` 的 `before` 所取的值，所以不再用 `nextBefore` 重述一遍。于是打开一个会话只需一页，`session.history` 以同样的 512 KiB 页把窗口其余部分往回走完。

`subagent.thread.v1` 让一种 delta 存在：宿主持久事件 `subagent/catalog` 登记一个被委派的子会话，桥据此发 `subagent`，载荷 `{childId, label?, mode?, callId?}`。`callId` 是派生出该子会话的那次 `tool/call`，判定按两级、先问 spawn 自己的结果：某条 `tool/result` 点名了这个 child——`subagent` 工具返回的激活句柄 `{"kind":"activation","subagentId":…}`（单独返回，或嵌在 `run_code` 的答案里），或它打印的 `started subagent …` 通知——就由那次调用决定，哪怕这一步发过多条调用、或一次调用起了一整队子会话。没有任何结果点名该 child 时，退回原有判据：同一个 turn+step 里恰好一条 `tool/call` 时才给；那一步发过两条以上、或该 call 已经关联过另一个 child 时一律省略，因为猜出来的 id 会把线程挂到错的卡片上。spawn 的 catalog 事件可能先于它自己的结果被投影，因此实时 delta 只能用这条流到目前为止带过的内容作答，而基线用整个会话作答——两边是同一条规则、同一个 `SpawnCallIndex`。`subagent/catalog` 因此也成了裁剪基线保留的 entry 类型之一，并在 `data.callId` 里带上派生它的那次调用：在子会话已经被派生之后才打开会话的手机，直接读到标签、模式与造出它们的调用，而不是从 agent 消息反推线程。`user-message` 的 `actor` 不受任何能力约束：delta 与快照里的 `user/message` entry 都带 `{kind, sourceKind, sessionId?, label?}`，机械地取自宿主自己的 `source` 记录——`user` 与 `user-approval` 是 `human`，`agent-message` 与 `subagent-settled` 是 `agent`，其余来源种类一律 `system` 并保留原文——所以一条消息不会因为来源种类没被本协议分类过就被丢弃，而 source kind 不可读的事件干脆不带 `actor`。跟随一个会话需要授权，而不是默认成立：本连接已经打开过的会话、以及名册里作为普通会话列出的会话可以直接跟随；被委派的子会话只有它挂靠的父会话属于这两者之一时才可跟随。父会话无法由任何名册解析出来的子会话回 `session-not-followable`，且不为它打开任何流，因此放宽子会话这道闸门不会变成读取调用方从未被授权会话的通道。普通会话用它自己的 id 寻址；被委派的子会话——名册行带 `origin:"subagent"` 的那些——只能通过它的持久父会话寻址，而把一个子会话当作普通会话来问，宿主会回 `session/agent-busy`。父 id 来自名册——唯一携带谱系的端点——而桥在第一次尝试之前就读它，因此名册指明了父的子会话直接用 `{kind:"subagent", parentSessionId, childSessionId, mode:"unknown"}` 寻址，并拿到自己的真实历史。那次读取没解析出父时，改由宿主自己的拒绝当信号：只对这一个会话用委派地址重试一次。先列会话再打开会话的客户端不会多付一次读取，而每个连接最多读一次名册。普通会话永远不为此付费：它们用自己的 id 第一次尝试就打开。没有内容可看的会话也不等于失败：日志里只有宿主自己记账记录的会话，回的是真实投影加一个空回合；只有拿不到开帧、或宿主自己抛错，才会被拒绝。

`session.list.omit-archived.v1` 是这里唯一不协商任何东西的能力。桥从不传输已归档的会话——宿主归档集在每次列出时读一次，其中每个 id 都在该行构造之前被跳过——无论客户端是否声明该能力，因此那之后写下的客户端拿到的就是它本来要自己过滤掉的较短名册。在它之后：没有任何 `session.list` 行是归档集点名的会话；存活行在不变的 schema 下仍携带 `archived: false`；读不到归档集的那次列出则一行都不丢。已归档父会话的活跃子会话仍是自己的一行，并仍然点出那个父 id：父 id 由子会话自己的行走带，因此父被归档从不会让子会话失去谱系。名册同时也是 delta 机器做差分的那一集，所以两次列出之间被归档的会话以移除的形式到达，被恢复的则以变更的形式到达，两者都不需要任何特例。

`session.history` 以分页方式往回读一个会话的历史，而且它是纯读：既不打开、也不丢弃或改指任何订阅，同一个游标永远给出同一页。它的数据来自 `session.snapshot` 所用的那份开帧基线，因此两者永远不会在某个回合或某条 entry 上给出不同答案——`history` 只是对这份投影做切片。分页按 **entry** 切，不按回合切：一页从调用方游标之下取最新的 entry，直到编码后的页达到 `maxBytes`（默认 524288，即 512 KiB）；因此一个回合的 entry 可以跨页，而该回合仍保留自己的 `seq`、`endSeq`、`reason` 与 `time`；单条 entry 若比整页预算还大，就独占一页，而不是被拒绝。`before` 是持久水位而非下标：这一页取 `seq` 严格小于它的 entry，所以游标跨连接仍然有意义，投影在它之下改变形状也不会让分页跳号或重复。省略 `before` 即取最新一页；`hasMore` 说明下面是否还有更旧的 entry，而下一页的游标 `nextBefore` 恰好在 `hasMore` 为真时出现。裁剪能力在这里的生效方式与快照完全一致。

`session.list` 除名册自身字段外还带上手机用来分组与命名的元数据：`cwd`、`parentSessionId`、`origin` 只在宿主确实上报时才出现，`blank` 始终存在，`archived` 只在本次进程能读到宿主归档集时出现——读不到就省略该键，而不是回 `false`。已归档的会话根本不是一行：归档集每次列出只读一次，其中的 id 在构造该行之前就被跳过，因此真正穿过去的标记永远是 `false`，而手机本来要藏起来的那些行一个字节都不再花。`title` 在本连接尚未通过 `session.titles` 解析过该 id 时保持 `""`，因此列名册仍然只是一次调用，且不会给每一行挂上一次标题读取。`session.titles` 用宿主自己的标题服务回答一批 1 到 100 个 id——读的是本进程的活跃会话，绝不为每个会话各开一条 follow 流——且每个被请求的 id 都是键：本宿主没有活跃持有的 id、或标题尚未落地的 id，一律回 `""`。一个已解析的标题会在 10 秒内被直接复用，之后才再问服务，因此重命名最多要等这么久才可见。与其它会话方法一样，没有设备令牌时两者都回 `unpaired`。

## 事件

| 主题 | 载荷 |
| --- | --- |
| `session.delta` | `{sessionId, kind, ...}`——某会话某一回合的一条增量（种类见下） |
| `approval.request` | `{sessionId, id, summary}`——有工具正在等待裁决 |

### session.delta 的种类

| 种类 | 附加字段 | 含义 |
| --- | --- | --- |
| `text` | `{text, blockIndex}` | 助手正文增量 |
| `reasoning` | `{text, blockIndex}` | 推理增量 |
| `tool-call` | `{callId, name, argumentsDelta}` | 工具调用增量；`argumentsDelta` 可为空串 |
| `tool-result` | `{callId, output, isError}` | 工具结果 |
| `turn-end` | `{reason}` | 回合结束；`completed` 之外都算异常结束 |
| `user-message` | `{text, messageId?, attachments?, actor?}` | 一条用户消息；`actor` 说明它从哪来 |
| `subagent` | `{childId, label?, mode?, callId?}` | 宿主登记了一个被委派的子会话；需能力 `subagent.thread.v1` |

`approval.request` 的摘要取自宿主按客户端语言给出的显示理由，缺失时回落英文、再回落工具名，并附带工具名本身。客户端用 `approval.resolve` 作答，`decision` 取 `allowed-once` 或 `rejected`；未知或过期的 `id` 会被拒绝，而无人应答的请求在两分钟后按 unavailable 结算，宿主视之为拒绝。工具发起请求的那一刻，每一条已配对连接都会收到该事件——首播不在任何能力名之后——而声明了 `approvals.v1` 的连接会在 `hello` 之后再次收到所有仍在等待的请求，因此重连过的手机、或事后才打开该会话的界面，手里依然有卡片。只有未结算的请求会被重放：已作答、已超时、已撤回的请求早已离开认领表，而重新递一次请求绝不会挪动它的两分钟截止时间。该能力只门控这第二次送达，因此它不出现在 `hello` 的 `capabilities` 里、也不改动 `minor`：握手对每个客户端都回同一个帧。桥只在下游有已配对客户端连接时才认领请求：一个都没有时，请求交给下一个应答者，而不是干等一台不在场的手机。

## 扩展缝

本包只发布一道通用扩展缝，自己的词表里不放任何业务词。已挂载的插件解析 cordis 服务 `remoteBridge`，即可向协议 v1 增加方法与事件，而桥不需要知道它们是什么意思：

| 成员 | 契约 |
| --- | --- |
| `registerMethods({capability?, methods})` | 增加一张客户端可调用的方法表，返回撤回它们的 disposer；`KNOWN_METHODS` 里的名字、空名字或另一张表已占用的名字一律拒绝，且整张表一起拒绝 |
| `broadcast(topic, payload, capability?)` | 向已配对的连接推送一个事件（指名能力时只投给声明了它的连接），返回实际收下该帧的连接数 |

已注册方法的派发排在两道协议闸门之后：没有插件注册的名字最先回 `unknown-method`；没有有效设备令牌的连接回 `unpaired`，与协议方法完全一致；从未声明该表所需能力的客户端同样回 `unknown-method`——方法对它而言不存在，而不是没有权限。处理器收到请求载荷与本连接 id，回 `{ok:true, r}` 或 `{ok:false, code, msg}`；两种都原样穿过，因为错误码归注册它的插件所有。处理器抛错、或两种形状都没回时，以桥自己的 `internal` 穿过。

自 fork 通道落地起 `hello` 回 `minor:8`；`minor:7` 是两条通道汇合的时候；`minor:6` 是其中任一条单独在位——agent 通道在 dev 上，持久历史分页在它自己的分支上；`minor:5` 时是名册不再携带已归档会话。`agents.v1` 背后，`presets.list` 与 `session.create` 转发宿主的预设名册与一次创建请求；`session.deep-history.v1` 背后，`session.history.deep` 把会话的持久存储一直翻到最早一条 entry；`session.fork.v1` 背后，`session.fork` 把一条会话分叉成继承它的新会话。`minor:4` 加了字节级增量，`minor:3` 是后台作业通道，`minor:2` 是子代理线程，`minor:1` 是本扩展缝。它们都没有改动主版本 1、任何冻结字段、方法名或主题名。唯一对每个客户端都变短的响应体是名册本身，它不再点名已归档会话；其余答案对什么都不声明的客户端仍是协议 v1 自己的。

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `unpaired` | 本连接没有有效设备令牌，而该方法不在未配对白名单内 |
| `snapshot-unavailable` | 读不到该会话的开帧——follow 流没产帧就结束，或 10 秒内没有开帧。宿主自己抛出的失败则带着它自己的错误码穿过 |
| `token-invalid` | bootstrap token 未知、已被用掉，或已超过 30 秒 |
| `nonce-invalid` | `pair.finish` 用的 nonce 从未签发、已被用掉或已过期 |
| `signature-invalid` | ES256 签名无法用所给公钥与 nonce 验证通过 |
| `approval-unknown` | `approval.resolve` 指的审批 id 未知或已过期 |
| `unknown-method` | 方法名不属于协议 v1 |
| `invalid-args` | 载荷与方法形状不符 |
| `proto-unsupported` | `hello` 握手声明的协议版本本桥说不出来 |
| `snapshot-too-large` | 开帧快照无法压缩进单帧：连一个回合都放不下 |
| `internal` | 桥在服务该调用时自身失败 |
| `frame-too-large` | 该帧超过 10 MiB 上限，未被解析 |
| `malformed` | 该帧不是形状可辨的单个 JSON 对象 |
| `direction-violation` | 客户端发来了只有宿主才发的 `res` 或 `ev` 帧 |

在 DSH 内部产生的失败同样不被改名：它带着 gateway 自己的错误码穿过桥，例如 `service-unavailable`、`invocation-unavailable`、`definition-unavailable`、`arguments-invalid`。只有服务激活窗口会被重试（5 次、间隔 2 秒），因为那是唯一「片刻后即成功」的失败。

## 鉴权

设备令牌随 WebSocket upgrade 以 `Authorization: Bearer <deviceToken>` 携带——这是首选载体——并对不便设置 header 的客户端接受 `?token=<deviceToken>`。比对为定长比较，不会在长度不符时短路。没有有效设备令牌的连接只放行三个方法——`hello`、`pair.begin`、`pair.finish`——其余方法在任何会话工作发生之前一律回 `unpaired`。

### Bootstrap token

`GET /remote-bridge/pair/token` 是宿主上的精确路由，门禁同时看两个条件：来源地址必须是 `127.0.0.1`、`::1` 或 `::ffff:127.0.0.1`，且 `Host` header 必须写本机（`127.0.0.1`、`localhost` 或 `[::1]`，端口忽略）。经隧道进来的请求即使其隧道客户端就从本机连出，也会在第二个条件上被拒，因此该端点在公网 origin 上够不到；其余情况一律 403。token 只存内存，30 秒后过期，被第一次 `pair.begin` 用掉即焚；同一条链接会打到宿主日志，配对码本身则渲染在配对面板里，桌面端两条路都能取。

```sh
curl -s http://127.0.0.1:3080/remote-bridge/pair/token
# {"token":"...","expiresAt":1760000030000,"url":"ws://127.0.0.1:3080/ios/v1?token=..."}
```

当这台机器能说出自己的公网地址时——先看 `DSH_REMOTE_PUBLIC_BASE_URL`，其次看 `dsh-remote-web-ui` 维护的中继注册表 `$DSH_HOME/remote-web-ui-registry/<profile>.json`——同一个响应里会多出地址那一半：

```json
{
  "token": "...",
  "expiresAt": 1760000030000,
  "url": "ws://127.0.0.1:3080/ios/v1?token=...",
  "origin": "wss://<id>.dsh-market.com",
  "originSource": "registry",
  "pairingUrl": "wss://<id>.dsh-market.com/ios/v1?token=..."
}
```

`pairingUrl` 就是二维码该装的东西：iOS 客户端会解析 `{token, url}` 并从 `url` 取 origin，所以扫一次就同时设好地址与一次性 token，手机上什么都不用输。查不到公网地址时这两个字段**缺省而非瞎猜**，面板退回只装裸配对码，手机保持它已有的地址不变。

### 设备令牌

`pair.begin` 应答一个 nonce 及其过期时刻；客户端用 P-256 密钥对 nonce 的原始字节签名，并以 base64url 的 SPKI 公钥与 base64url 的 ES256 签名调用 `pair.finish`。签名必须是 WebCrypto 与 CryptoKit 产出的原始 64 字节 `r||s` 形态，不能是 DER 包装：宿主先校验长度再验签，重新编码过的签名会被拒绝。宿主回一个 32 随机字节的 base64url 设备令牌及其 deviceId。服务端只存该令牌的 SHA-256 哈希，因此名册文件即使被拿走也换不出可用凭据。

## 设备名册

名册落在 `$DSH_HOME/remote-bridge/devices.json`，是一份带版本号的文档，每个已配对设备一行：

```json
{
  "version": 1,
  "devices": [
    {
      "deviceId": "dev_9Qm2r0Tn1Zk4",
      "pubKey": "<base64url SPKI, P-256>",
      "fingerprint": "<sha256 of the SPKI>",
      "createdAt": 1760000000000,
      "lastSeenAt": 1760000000000,
      "tokenHash": "<sha256 of the bearer token>"
    }
  ]
}
```

文件里没有任何可直接使用的明文凭据：一行保留设备的公钥、指纹，以及签发给它的令牌的 SHA-256，从不保留令牌本身。目录为 0700、文件为 0600；写入先落临时文件、flush 后再原子 rename，崩溃不会留下半截名册，解析失败的文件会被改名加上 `.corrupt-<时间戳>` 后缀隔离，而不是被当作空名册。协议 v1 没有吊销方法，所以吊销一个设备就是移除它的那一行（或删掉整个文件）再重启宿主：名册每个进程只读一次，自那次启动起该设备连接即未配对。

## 中继

把私网实例发布到公网的中继是**全量反代**：它查出实例当前的隧道目标，只重写 `Host` header，其余原样转发 origin 的响应——唯一按路径区分的规则是对内容哈希的 `/assets/*` 加不可变缓存。WebSocket upgrade 走的是同一跳：Workers 运行时在客户端发出 `Upgrade` 请求且 body 为空时，会让该 `fetch` 升级为 WebSocket。因此协议 v1 只是同一 origin 上的又一条路径：Worker 无需改动、不需要第二条隧道、也不需要多发布一个 origin。

这一跳带来两条后果。它看得见请求 URL，所以用 `?token=` 连接等于把设备令牌交给中继、Cloudflare 边缘与 origin 访问日志——优先用 header。而 `GET /remote-bridge/pair/token` 会像其他路径一样被转发，但它的 loopback 门禁会拒掉这条转发请求，因此配对只能从本机发起。

## Web GUI 配对面板

浏览器半区存在的理由，是让从不开终端的操作者也有一条发起配对的路径。它沿用家族在侧栏底部的惯例：触发器注册进官方 `sidebar.footer.action` 列表槽位（由 ui-sidebar 声明——`dsh-remote-web-ui` 的手机触发器与 `dsh-update` 的更新器已经共用的那个座位），点开后是居中弹窗。它由同一插件行承载：产物是 `exports["./client"]`，`dsh.client` 声明必须先就位的 client 模块。

面板只做一件事——把活着的那个一次性配对码摆到操作者面前：

- **二维码里只装裸 token**：43 个 base64url 字符，别的什么都没有。若放 URL 或 JSON，手机端的解析器会顺手把 origin 改写成这台机器的 loopback 地址，而那恰恰是手机够不到的地址。
- **同一个 token 以明文印在二维码旁边**，操作者可用肉眼核对，并有复制动作把它放进剪贴板。
- 旁边跑 **30 秒倒计时**，配一个 **「重新取码」** 动作：每按一次都签发新 token 并作废上一张；过期的配对码会明说过期，而不是继续一副还能扫的样子。
- **origin 警告直说。** 本页所在的 `127.0.0.1:<端口>` 只有本机能连，所以手机 App 里的连接地址必须填公网中继，形如 `wss://<id>.dsh-market.com`。
- **失败不静默。** 取码走的就是操作者本可以用 curl 打的那条仅 loopback 路由：`403` 渲染成「这个页面不是从本机打开的」，请求没到达则渲染成它自己的不可达状态。

面板对原生路径而言只是显示层。它从不消耗配对码（`pair.begin` 始终是手机那一侧的动作），从不碰名册，也不新增任何 wire 面——信封、方法名、主题名与事件一律不动。`dsh-remote-web-ui` 的配对服务、名册与浏览器凭据同样不参与其中，因此两条远程面各自保留自己的访问控制。

## 客户端脚本

`scripts/client.mjs` 是一个零依赖的协议 v1 客户端——只用 Node 22 的内置全局，不引任何包——用于对活着的桥接做检查，也给没有 Secure Enclave 的测试机配对。它按固定顺序跑一遍，给每帧加方向前缀、把事件按到达顺序编号，整段输出可直接粘进报告；它自身不执行任何模型调用。

```sh
# check a paired connection: hello -> session.list -> session.snapshot -> session.prompt -> session.delta
BRIDGE_URL=ws://127.0.0.1:3080/ios/v1 BRIDGE_TOKEN=<deviceToken> node scripts/client.mjs

# pair this machine with a throwaway P-256 key and print the device token
node scripts/client.mjs --pair --pair-base http://127.0.0.1:3080
```

## 安装

### 从 npm 安装

```sh
dsh plugin --profile web add @linxin666/dsh-remote-bridge@latest
```

### 从仓库安装

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install && pnpm -r build
dsh plugin --profile web add link:$(pwd)/packages/dsh-remote-bridge
```

家族聚合包 `@linxin666/dsh-web-all` 会连同家族其余内容一起装上本插件。安装或更新后需重启 `dsh web`——宿主半区在插件行挂载时注册路由，提供服务的就是那个运行中的宿主——随后刷新 Web GUI 页面，浏览器半区在侧栏底部的触发器才会出现。

## 配置

桥接像其他宿主插件行一样挂载。v1 不带任何面向用户的选项：本文中的取值——30 秒一次性 bootstrap token、仅 loopback 的 token 端点、10 MiB 单帧上限、固定的 `/ios/v1` 路径——都是协议常量而非设置项。配对与吊销也不是配置，而是名册里的逐设备事实。桥接唯一依赖的环境事实是 `$DSH_HOME`，因为名册就在它下面。

## 安全模型

- **配对即完全控制凭据。** 已配对设备在同一进程内触达宿主：会话、发言、审批。只配对你掌控的设备，吊销方式是移除名册那一行并重启宿主。
- **进程内调用以 owner 身份发言，且只在桥自己的门禁之后。** 自 DSH 0.2.1 起，宿主网关要求每次调用都指明代表谁发言，桥的回答是自己在挂载时铸造的一个进程内 owner peer（`{kind:'owner'}`），挂到每一次网关调用上。这个声明之所以安全，是因为它只在桥自己的配对检查之后才会被用到——未配对连接在任何网关调用存在之前即被拒——且协议帧的任何字段都不能设定 principal：客户端在载荷里自报的身份会被忽略。该 peer 不接收转发事件交互，因此它也永远收不到宿主转发事件。
- **token 端点仅 loopback 可达，且看两个条件。** 来源地址必须是 loopback，且 `Host` header 必须写本机。经隧道的请求由本机的隧道客户端终结，所以对一条全互联网可达的请求，来源地址也读作 `127.0.0.1`；而中继与普通隧道都会把 `Host` 改写成公网名。任一条件不成立即 403。token 只存内存、30 秒过期、被一次 `pair.begin` 用掉即焚，同一条链接还会写进宿主日志——把那一行日志当作活着的密钥。
- **配对面板渲染的是一份活密钥，也仅止于此。** 它用同源请求读同一条仅 loopback 门禁的路由，所以在 `curl` 够得到的地方它才够得到，别处都不行。它不能签发设备令牌、不能消耗配对码、不能列名册、不能吊销设备：`pair.begin` 始终是手机那一侧的动作，吊销始终是改名册加重启宿主。二维码里装的是裸 token，因此本页自己的 `127.0.0.1` origin 永远不会被交给手机。
- **未配对连接只有三个方法的白名单。** `hello`、`pair.begin`、`pair.finish`；其余方法在分发前即回 `unpaired`，因此没有设备令牌就够不到会话面、审批面与名册面。
- **设备令牌只存哈希。** 名册保留公钥及其 SHA-256 指纹，从不存令牌本身，所以该文件不是凭据库。令牌丢失、轮换或被拒的处置就是重新配对——这是常规流程而非异常路径（重新签发一条 bootstrap 链接，或在桌面配对流程里重扫），且从不需要手工改名册。
- **令牌比对不泄漏长度。** 用的是定长比较而非提前返回的比较，因此错误令牌无法被逐字节逼近。
- **审批在客户端在线时 fail closed。** 只要还有一个已配对客户端在线，桥才认领工具的权限请求；一个都没有时，请求交给下一个应答者而不是卡住。已认领而无人应答的审批会被归一为 `unavailable`，宿主按拒绝处理：手机沉默永远不等于同意。
- **header 是更安全的载体。** `Authorization: Bearer <deviceToken>` 让凭据不进入 URL；`?token=` 是给无法设置握手 header 的客户端的，此时中继、边缘与访问日志都会看到一条以该设备身份鉴权的 URL。

## 已知限制

- **标题属于活跃会话。** `session.titles` 读的是本宿主进程活跃持有的会话的标题；名册仍会列出未被挂载的持久会话，这些 id 在宿主挂载它们之前一律回 `""`。
- **已服务过的标题最多可能旧 10 秒。** 一个已解析的标题在 10 秒内被直接复用，之后才再问标题服务，因此重命名或刚生成的标题最多要等这么久才出现。
- **读不到归档集时没有 `archived` 键。** 该标记来自宿主的 workspace registry；该服务未挂载时，每一行都省略此键，而不是回 `false`，并且一行都不丢——读不到的桥不会给出更短的名册。
- **已归档的父会话不授权任何东西。** 已归档父会话的活跃子会话仍会被列出、也仍点出那个父，但在父被恢复之前跟随该子会话会回 `session-not-followable`：授权一个会话的是名册，而已归档的那个已不在名册上。
- **`lastSeq` 与 `seq` 是两个计数器。** `session.snapshot` 的 `lastSeq` 是宿主流的 cursor，事件的 `seq` 是本连接自己的事件序号，二者不可比较；续传状态属于客户端。
- **不做增量补发。** 发现跳号或重连的客户端重新调 `session.snapshot` 拿完整基线；本包不为断开的客户端缓存 delta。
- **被委派的子会话每个连接最多付一次名册读取。** 子会话的持久父 id 只有 `session.list` 会发布，所以一个连接在没先列名册的情况下打开的第一个子会话，要付一次名册读取；此后任何父名下的任何子会话都不再付费，而先列名册再打开的客户端一分不付。名册若解析不出该子会话的父，桥回 `session-not-followable`，而不是编造一个地址；父不是本连接已授权会话的子会话同样如此。
- **`session.history` 到不了开帧窗口之下。** 分页走的就是 `session.snapshot` 所用的那份基线，因此最旧可达的 entry 就是那个窗口里最旧的 entry——受宿主自己的 `maxMessages` 窗口（200 条消息）限制。开帧上的 `hasMore` 是宿主对更旧内容的回答，桥不会越过它去取。
- **比一帧还大的单条 entry 无法被塞进预算。** 分页首屏与 `session.history` 都会让这样的 entry 独占一页而不是拒绝，因此承载它的那一页可能超过 10 MiB 单帧上限；其余每一页都留在自己的预算之内。
- **工具调用参数以增量到达。** `tool-call` 增量的 `argumentsDelta` 可以为空串，参数由客户端拼装；整次调用不会被重发。
- **订阅比 interrupt 活得久。** `session.interrupt` 只取消回合；订阅在连接关闭时结束，一个连接名下的 follow 流由同一个 AbortController 一起 abort。
- **`clientTimeZone` 由宿主侧填写。** 桥接用本机 IANA 时区填充它；v1 里客户端无法指定自己的时区。
- **名册改动在下一次宿主启动时生效。** 名册每个进程只读一次，因此移除设备要等 `dsh web` 重启才起作用。
- **面板只显示一个配对码，别的都不做。** 它不能列出、命名或吊销已配对设备，也从不消耗配对码——配对发生在手机上，吊销仍然是改名册加重启宿主。
- **面板的新鲜度只到它上一次取码为止。** 它在打开时取一次码，之后每按一次「重新取码」再取一次；一直开着时过期的码会翻成过期状态，而不会自己悄悄续期。
- **`scripts/client.mjs` 是检查用的工具，不是客户端 SDK。** 它只按固定顺序跑一遍，不保存状态，也没有重连逻辑。
