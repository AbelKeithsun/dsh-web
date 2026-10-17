# Agent Note: 经两道增量扩展缝把看板搬到远端面

Status: implemented

## Problem

远端桥（协议 v1）此前只服务会话、提示词、审批与宿主提问。任务看板——宿主权威的任务账本、调度与执行——完全没有远端面，于是一台手机可以发起回合，却看不到也驱动不了决定哪些回合会跑的那块看板。

有三条事实决定了这次修法的形状：

- **桥不能学看板的词。** 它的方法表与主题表由父卡冻结（§1–§11）；把 `board.*` 塞进去，等于把一个插件的业务放进每个客户端都要讲的协议里。
- **看板的 HTTP 面在宿主进程内够不到。** 它的路由按浏览器形状的请求守卫（`packages/dsh-task-board/src/host-routes.ts` 的同源与 `sec-fetch-site` 判定），进程内 `fetch` 去 `/api/task-board/*` 会被拒绝。而看板自己的能力面只是 `TaskBoardHostService` 实例上的方法，没有任何 cordis 服务发布它。
- **当时唯一发布的 `taskBoard` 服务只有提供方登记那一对方法**（`registerExtension`、`isExtensionEnabled`），它给提供方的是 `tasks.*` / `integration.*` / `events.*`——够 GitHub 式提供方用，离带 `scheduler` 与 `power` 的快照差得远，也没有施加任意动作的路径。

## Decision

看板经两道增量扩展缝和一个新包到达远端面，两道缝彼此都不认识对方的词。

1. **桥提供一道通用扩展缝。** `packages/dsh-remote-bridge` 发布 cordis 服务 `remoteBridge`，含 `registerMethods({ capability?, methods })`（返回 disposer）与 `broadcast(topic, payload, capability?)`。桥在自己的闸门之后派发已注册的名字——未注册的名字最先回 `unknown-method`，未配对连接回 `unpaired`（与协议方法一致），从未声明该表能力的客户端被告知方法不存在——并把插件的 `{ok, r}` 或 `{ok:false, code, msg}` 原样穿过。`hello` 回 `minor: 1`，主版本 1 与全部冻结字段、方法名、主题名都没有变化。
2. **看板多一个窄的进程内面。** `taskBoard` 服务增加 `snapshot()`、`apply(requestId, action, initiator?)`、`subscribe(listener)` 与 `verificationOptions()`，每一个都是宿主同名服务方法的**转发**。发布出去的对象里没有闸门、没有归一化、没有状态，因此经这条路到达看板的消费者，被拒绝的规则与浏览器完全相同。原有两个成员一字未动。
3. **一个绑定包。** `packages/dsh-task-board-remote` 拥有看板的线路词表（`board.v1`、`board.snapshot`、`board.options`、`board.apply`、`board.changed`、`board-unavailable` / `board-refused`），结构化解析两个席位（`ctx.get` 加 `ctx.inject`，不 import 任何一方），只做形状转发、按连接的 `requestId` 重放与一波合并。所有业务判定——运行中锁、权限确认门、子任务深度、调度次数预算、验收契约——留在账本里。

线路契约由 `iphone_remote_use_dsh/docs/protocol-v1.md` §12 冻结；本记录说明两道缝为何存在，不重复帧长什么样。

## Context & Efficiency Impact

桥多了一张按方法名的注册表和一个每条连接的可选字段；没挂任何扩展时，`KNOWN_METHODS` 之外的名字只多一次 `Set.has`。看板在自己已经创建的服务对象上多四个转发，插件多一张按连接有界（128 键）的重放表和一个微任务合并器。账本 schema、看板自己的 HTTP 面与浏览器 bundle 都没有增加（插件是纯宿主半区）。为 `board.changed` 读一次 revision 要付一次完整 `snapshot()`，因为看板不提供只读 revision 的入口；合并器因此把它压成每波一次深拷贝，而不是每次变更一次。

## Alternatives considered

**让远端插件走 loopback 调看板 HTTP API。** 在动手之前就否决了：看板路由守卫只认浏览器形状的请求（同源或 `sec-fetch-site`），进程要做到就得假装成浏览器，而给一个消费者另开一套访问控制的故事，正是那道守卫要防的东西。宿主进程本来就有进程内通道——服务——用它才能只有一套授权模型。

**把整个 `TaskBoardHostService` 实例当服务值抛出去。** 否决：那个实例暴露账本、执行 runner、调度器与电源抑制器，消费者可以绕过本任务要保住的闸门，而且它的形状会变成每个消费者的承重契约。四个具名转发才是契约，其余保持私有。

**让插件自建传输（自己的 WebSocket 或自己的 HTTP 路由），而不是扩展桥。** 否决：第二条连接面会重复设备令牌、配对与能力判定——那正是远端面可信的来源——而手机还得带两个客户端。

**把 `board.*` 写进 `KNOWN_METHODS`，让桥直接服务看板。** 否决：桥从此持有看板词表，看板的任何变化（新动作种类、新 meta 字段）都会变成协议变更，而且桥再也不能和一块它不认识的看板一起挂载。

## Consequences

- 增加一个远端能力不再需要动桥：插件注册一张表和一条主题，桥的义务只剩保持派发与投递的通用性。将来要暴露别的面（计划、日志）应当走同一道缝。
- 看板发布的面现在是兼容面。四个转发必须持续跟随它们所转发的宿主服务方法；宿主方法改名会变成可见的类型断裂，而不是静默错位。
- 手机发起的动作不传 `initiator`。看板把该字段定义为发起动作的 DSH 会话 id，而手机不是会话；塞一个替身会以从未存在过的会话 id 进入执行审计与工作区继承查询。代价是手机建的卡片拿不到会话工作区钉子，执行时回落到看板的「最近工作区」规则。
- 全量快照没有分页。任务多到超过协议 v1 的 10 MiB 帧上限时只回 `board-unavailable`；§12 记下这条限制，本记录不解除它。
- 这里没有做手机端的端到端验证：桥扩展缝、看板面与插件各自有自己的测试，真机往返仍是人工步骤。
