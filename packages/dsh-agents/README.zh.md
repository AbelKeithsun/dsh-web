# @linxin666/dsh-agents

[English](README.md) | 中文

DSH Web GUI 的 Agent 小队：可复用的成员定义（agent 预设、权限、模型钉住、思考档位、成员简报），简报进入该成员会话的系统提示词，由 Host 用真实 DSH 会话执行。

## 功能

- **小队**是有序定义：名称、可选描述、可选钉住工作区、可选排序值，以及一份成员列表。
- **成员**是可复用定义：显示名、可选 DSH agent 预设 id、权限、模型钉住、思考档位，以及一段简短简报。
- 成员绑定的是预设 id，不是提示词。本机运行的桌面 profile 已内置 `@local/dsh-siji-research-squad`，其中的 `xundong`（寻冬）、`michun`（觅春）、`zhixia`（知夏）、`luoqiu`（落秋）就是用户已有的研究小队预设，因此第一批小队无需另写预设。
- 简报进入**该成员会话的系统提示词**，绝不写进首条用户消息；普通会话不受影响，其它装配收到的是空段，由 Host 丢弃。
- 运行成员时经宿主 agent 预设注册表解析预设、经宿主网关创建会话、把会话改名为 `<小队名> / <成员名>`、钉住权限与模型路由，并记录一条运行记录。

## Agent Teams 运行期

- 整队运行是小队页上的一个动作：可选目标加可选 Lead 预设。目标随运行请求上送；Lead 预先是小队自己的字段（`TeamDefinition.leadPreset`），因此这次选择跨过这次请求、跨过页面刷新、也跨过下一台设备，而不是随一次运行消失。
- Lead 预设选择器只提供 `GET /state` 在 `presets` 里报出的 id，注册表标记为不可用的预设不会出现。部署没有预设注册表、或注册表出错时该字段整体缺省；注册表里没有一个可用预设时同样缺省。页面改为陈述小队自己钉住的值，而不是给一个空列表。
- 启动顺序就是契约：先校验小队钉住的工作区，再在任何会话存在之前向注册表解析 Lead 预设，把会话改名为 `<小队名> / Lead`，并在首条消息入队之前写入整队运行记录，因此 Lead 的第一次装配就知道自己带的是哪支小队。
- Lead 的模型工具按成员派出 teammate。每个 teammate 都按该成员定义的钉住值组装：预设先于子会话存在解析，权限与模型路由在 teammate 首条提示被 checkpoint 之前落到该会话。本部署兑现不了的钉住会让这次派出以具名错误失败，绝不悄悄退回部署默认值。
- 小队成员名单与目标以 `team:squad` 系统提示词 **context**（不是 section）送达 Lead，因此登记了 `complete` 段的成员预设也无法把它们丢掉。
- 实时队伍视图从共享的客户端会话仓库读取 fork 运行期的 `agentTeam` 会话投影（`stateVersion` 4）：Lead、它派出的每个 teammate、每行的角色与阶段，以及没能启动的成员的失败文字。该投影能作答期间，页面不做任何轮询。
- Team 工具只安装到本 Host 自己启动的整队运行会话里。普通会话（日常对话、普通协调回合）看不到任何 Team 工具，并继续保留原生 subagent 工具——本包从不关闭它们。
- 运行记录同时覆盖两类：带 Lead 会话与目标的整队运行，以及带成员名与「打开会话」动作的成员运行；最新在前，上限是 Host 保留的 200 条。
- 页面把每一种失败变成一句话：传输层失败读作 not-mounted、unauthorized、forbidden、timeout、unreachable 或 unexpected；Host 拒绝在 unknown-preset、no-workspace、squad-missing、lead-create-failed、lead-prepare-failed、ledger-unavailable 上保留自己的类别；其余 code 一律读作普通拒绝，引用 Host 那句有界原文。
- 运行结算不在此处观察：已启动的运行保持 `running`，直到后续里程碑接管其结果。

上述每一处差异，以及它偏离的精确上游基线，都记录在 [docs/fork-provenance.md](docs/fork-provenance.md) 与 [docs/runtime-deltas.md](docs/runtime-deltas.md)；两者是维护者契约，不是建议。

## 安装

```sh
pnpm add @linxin666/dsh-agents
```

经 profile patch 挂载插件行；bundle 自带一行 host 半区，行名与包名完全一致。

## 配置

- `enabled`（默认 `true`）：挂载账本、路由与成员简报段；关闭时该行不注册任何东西，也不持有锁。
- 账本目录为 `$DSH_HOME/dsh-agents`，与本家族每个插件解析自身存储的方式一致。

## HTTP 接口

```text
GET  /dsh-agents/api/state
POST /dsh-agents/api/team
POST /dsh-agents/api/team/delete
POST /dsh-agents/api/member
POST /dsh-agents/api/member/delete
POST /dsh-agents/api/run
POST /dsh-agents/api/squad/run
```

- 浏览器半区去掉前导斜杠，与任务看板的前缀处理一致；页面挂载期间轮询 `state` 刷新。
- 失败一律是 JSON：稳定 code 加一句有界文字；协议上不出现堆栈、账本内容或会话文本。

## 存储

- 单个 JSON 账本 `$DSH_HOME/dsh-agents/ledger.json`，以 fsync 临时文件加 rename 写入，经 `ledger.json.lock` 由唯一 pid 占有。
- 不可读、损坏或代次不符的账本会被明确报出并原样保留：本插件从不重置、隔离或覆盖用户的定义。

## 安全模型

- 路由围栏拒绝跨站标记、非 loopback 套接字，以及完全不带浏览器同源信号的请求。
- id 与时间戳由 Host 铸造；带未知字段的草稿直接拒绝而不合并，调用方无法给自己的行盖戳。
- 成员简报是用户自写文本：只送达本插件为该成员开启的会话，且只经系统提示词。

## 已知限制

- 小队必须钉住工作区：未钉住的小队以 `workspace-required` 拒绝，不会落在 Host 进程碰巧所处的目录里。
- 钉住的预设必须由宿主注册表提供；未知或损坏的预设会在任何会话存在之前 fail closed。
- 注册了 `complete` 系统提示词段的预设独占提示词，成员简报会被丢弃；该例外与兜底设计见 [docs/member-prompt.md](docs/member-prompt.md)。
- 思考档位只随它所属的模型钉住一起下发，因此只钉档位未钉模型的成员按会话默认运行。
- 运行历史保留最新 200 条；更早的记录随其引用到的定义一并丢弃。

## 测试

```sh
pnpm --filter ./packages/dsh-agents test
pnpm --filter ./packages/dsh-agents typecheck
```
