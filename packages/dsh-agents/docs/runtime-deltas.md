# 与官方运行期的刻意差异（不得「修正」）

本文件归属 `packages/dsh-agents`：列出 `src/team/` 与 `src/tools/` 相对官方 Agent Teams 运行期**看起来像 bug、实际是刻意如此**的几处差异，以及每一处的理由与钉住它的测试。基线、逐文件映射与改动清单属于 [fork-provenance.md](fork-provenance.md)，此处不重复；成员简报的注入判定属于 [member-prompt.md](member-prompt.md)。

判断标准很简单：一条差异如果能让「普通会话」和「整队运行会话」表现得一样，它就不是这里的差异，而是本包的主契约（见 [包 README](../README.zh.md)）。

| 刻意差异 | 为什么必须保持 | 谁来钉住 |
|---|---|---|
| Team 工具只装进本 Host 自己启动的整队运行会话 | 上游的 `tryMembership` 对任何根会话都回答 `{ role: 'lead' }`，照抄等于把整套 Team 工具注入用户的日常对话；本包的门禁是台账里确有一条整队运行记录，命中该会话本身或其父会话 | `tests/team-runtime.spec.ts`：普通根会话零工具、整队会话九个工具、`refresh()` 重扫 |
| 不关闭任何原生 `tool-subagent*` 工具行 | 两套委派面并存是对上游取舍的拒绝；为了「少一次工具选择」关掉原生 subagent，普通会话就失去官方委派能力 | `tests/team-runtime.spec.ts` 遍历 `src/`、`cordis.patch.yml` 与 `package.json`，断言包内不出现 `tool-subagent` |
| 投影 key 固定 `agentTeam`、`stateVersion` 固定 4 | 已落盘的投影与读取该 key 的消费方（浏览器半区的 `src/client/team-source.ts`）都依赖这两个值；改名或升版等于让历史会话的实时视图全部消失 | `tests/team-runtime.spec.ts`：两个常量，以及每次挂载在 root 上恰好注册一次 |
| 权限与模型钉住在首条提示 checkpoint **之前**应用 | 先 checkpoint 再钉，首条提示已经以部署默认的身份与模型落盘，钉住只是事后改写；顺序是 preset → start → permission/model → checkpoint | `tests/team-runtime.spec.ts` 的 pin 顺序用例 |
| 浏览器读会话投影，而不是读 Host 路由 | 投影是官方 UI 已经在算的共享状态，读它零请求、零轮询；`GET /dsh-agents/api/squad/team` 在 `protocol.ts` 里只是提案，刻意不实现 | `tests/client-squad-team.spec.tsx`：投影来源优先、提案路由兜底、无路由时说一次 `unavailable` 而不是永远轮询；`DSH_AGENTS_ROUTE_PATHS` 不含该路径 |

## 提案路由为什么留在提案

`GET /dsh-agents/api/squad/team` 的请求与回复形状、以及轮询兜底，都已经在浏览器半区写好（`src/client/team-source.ts`）。真要实现，Host 侧只需在 `DSH_AGENTS_ROUTE_PATHS` 加一条、在 `src/host/routes.ts` 注册一条，页面不用动。

现在刻意不做：本包一旦开始轮询自己的 HTTP 路由，就把「同一进程里的共享状态」升级成网络契约，还要连带处理围栏、缓存与失联重试；而官方客户端会话仓库已经把 `agentTeam` 投影送到页面，读它没有这些代价。因此在今天的部署里，这条路由永远答 `not-mounted`，页面据此显示「实时状态不可用」，运行记录照常可用。

实现那条路由时必须同时做的三件事（否则会把上面这条差异变成 bug）：把它加进 `DSH_AGENTS_ROUTE_PATHS`；只回答一个 Lead 会话的成员行，不暴露会话正文；保持浏览器侧 `createTeamSource` 的投影优先顺序不变。

## 换基线时怎么办

换上游基线不是改代码，而是重放对照表：先按 [fork-provenance.md](fork-provenance.md) 的「基线」一节更新四个哈希，再逐条重放本文件与 fork-provenance「我们对上游做的改动」两节；任何一条被上游吸收，就在两处同时删掉。只改代码不同步这两份文件，等于把下一任维护者唯一的对照表作废。
