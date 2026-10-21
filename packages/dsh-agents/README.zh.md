# @linxin666/dsh-agents

[English](README.md) | 中文

DSH Web GUI 的 Agent 小队：可复用的成员定义（agent 预设、权限、模型钉住、思考档位、成员简报），简报进入该成员会话的系统提示词，由 Host 用真实 DSH 会话执行。

## 功能

- **小队**是有序定义：名称、可选描述、可选钉住工作区、可选排序值，以及一份成员列表。
- **成员**是可复用定义：显示名、可选 DSH agent 预设 id、权限、模型钉住、思考档位，以及一段简短简报。
- 成员绑定的是预设 id，不是提示词。本机运行的桌面 profile 已内置 `@local/dsh-siji-research-squad`，其中的 `xundong`（寻冬）、`michun`（觅春）、`zhixia`（知夏）、`luoqiu`（落秋）就是用户已有的研究小队预设，因此第一批小队无需另写预设。
- 简报进入**该成员会话的系统提示词**，绝不写进首条用户消息；普通会话不受影响，其它装配收到的是空段，由 Host 丢弃。
- 运行成员时经宿主 agent 预设注册表解析预设、经宿主网关创建会话、把会话改名为 `<小队名> / <成员名>`、钉住权限与模型路由，并记录一条运行记录。

## 当前里程碑范围

- 一个成员开启一个会话；运行记录是 Host 对「该会话确实存在」的证据。
- 整队运行不属于本里程碑；定义与运行之间的接缝（`src/host/run-gateway.ts`）就是官方 agent-team 服务将来的接入点。
- 运行结算不在此处观察：已启动的运行保持 `running`，直到小队服务接管其结果。

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
```

- 浏览器半区去掉前导斜杠，与任务看板的前缀处理一致；M1 在页面挂载期间轮询 `state` 刷新。
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
