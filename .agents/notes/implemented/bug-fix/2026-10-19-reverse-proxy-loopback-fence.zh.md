# Agent Note: 带转发头的反代请求一律判为远程

Status: implemented

## Problem

dsh 部署常被放在反向代理后面：Cloudflare 隧道、frp，或 nginx 反代，它们终结公网连接并拨向宿主的 `127.0.0.1:<port>`。这样一跳恰好同时满足回环判定两半，而请求其实来自公网：

- 源站看到的套接字对端就是代理，代理经回环接入，因此 `request.socket.remoteAddress` 是 `127.0.0.1`；
- 代理把 `Host` 头改写成它自己的上游字面量（`127.0.0.1:<port>` 或 `localhost:<port>`），Host 这一半也成立。

两个事实各自为真、合起来毫无意义：请求从来不是本机的。共享围栏（`isLoopbackRequest`）与本仓自己的控制面判定（`packages/dsh-remote-web-ui/src/gate.ts` 的 `isLoopbackClient`）都返回 true，于是 `makeGateListener` 不校验设备 cookie 直接放行，仅限回环的配对控制面（铸造、停止、撤销、设备列表、事件流）为一个未认证的公网调用者服务；仅桌面可见的状态视图（`/api/pair/status`）也把回环快照交给了它。

区分这两种情形的信号，正是代理自己盖上的转发头：`CF-Connecting-IP` 与 `X-Forwarded-For` 只会因为中途有跳转发而存在。issue #1906 记录了这次报告。

## Decision

携带 `CF-Connecting-IP` 或 `X-Forwarded-For` 的请求永不被判为回环。

- 规则只存在一份，在 `shared/host/loopback.ts`：`isProxiedRequest` 报告两个头是否存在，`isLoopbackRequest` 在读取 Host 之前直接拒绝这类请求。以 `isLoopbackRequest` 围栏宿主路由的每个包（ssh、git-graph、market、plugin-manager、session-archive、skill-explorer、task-board、task-board-github、usage、update）因此经各自的生成副本继承该规则，副本由 `node scripts/sync-shared.mjs` 刷新。
- `packages/dsh-remote-web-ui/src/gate.ts` 的 `isLoopbackClient` 应用同一条规则。该判定守护 `api/gate` 监听器、`/api/pair` 控制面与仅桌面可见的配对快照，因此一处改动覆盖全部入口，而不是让每条路由各长出一次检查。
- 规则以请求头是否存在为准，不看其取值。转发空值或可伪造值的代理仍会把请求标记为被转发，调用方自带的取值永不被当作任何证据。这也正是 accept 限流对边缘追加 hop 的既有用法不受影响的原因：那段代码本来就只对回环对端的请求读取该头，而回环对端现在恰好就是被转发的请求，且它从不授予权限。
- 浏览器同源标记（`sec-fetch-site`、`Origin`）保持原有位置与顺序：跨站标记仍然先拒绝，原本要求 Origin 匹配的地方仍然要求匹配。真实桌面请求——回环套接字、回环 Host、无转发头——判定结果与改动前完全一致。

## 规则看不见的部分

规则是请求头测试，而反向代理是可配置的。三处残余风险是刻意保留并写进包 README 安全模型的，而不是藏起来：

- 被配置成丢弃这两个头的代理会把请求重新放回与桌面相同的形状，任何基于请求头的规则都无法区分它。Cloudflare 与 nginx 默认转发 `X-Forwarded-For`；手写的一组 `proxy_set_header` 若漏掉它，或写成 `proxy_set_header X-Forwarded-For ""`，则不会转发。
- 本机进程可以伪造任何请求头，正如它本来就能伪造本机工具发出的 `Origin`。本地信任模型没有任何变化：桌面依旧不需要凭据。
- 桌面外壳自己的重发服务与本包的回环代理（`loopback-proxy.ts`）都不转发转发头，因此二者不会因为这条规则被新挡住。

## Alternatives considered

干脆拒绝回环 Host 的方案被否决：桌面正是从 `127.0.0.1` 提供服务，基于 Host 的封禁会连同本地应用一起打掉，只为处理代理情形。

保留一份可信代理名单（只有已配置的代理才能把请求标记为被转发）被否决为安全修复的错误默认值。它是失败开放（fail open）的配置面：未配置时不设防，而恰恰是需要这处修复的部署从来没有配置过；以「转发头存在」为准则失败关闭（fail closed）。

从 `X-Forwarded-For` 归一化出真实客户端地址再判定，被否决：除非知道可信跳数，否则该值由调用方提供，跳数一错就等于换个花样重建同一条绕过路径。本 note 实现的正是 issue 已定的决策——带转发头即非本机——它不需要知道拓扑。

只修 `gate.ts` 被否决，理由与共享围栏存在本身相同：十个同级包都以 `isLoopbackRequest` 围栏，只修一个会把这同一条绕过路径留在其余包里。

## Consequences

- 反向代理后面的部署不再享受回环待遇：配对控制面对它返回 403，状态视图把它当作未配对的局域网调用者应答，而不是交出桌面快照。这正是修复的预期结果，也是把该绕过路径当便利使用的用户能看到的可见行为变化。
- 配对通道与浏览器半区不受影响：配对过的设备经它出示的归一化 Host 到达 `/remote`，隧道落地流程照常工作，因为它从未声称自己是回环。
- 本仓自己仪表化的隧道路径不受影响：accept 限流早已按边缘追加的 hop 为被转发请求分桶，`x-forwarded-proto` 依旧只决定 cookie 的安全性。
- 仓库内每一份 `loopback.ts` 副本会同时改变，因为该文件是生成的；任何未重新同步的副本会让 `pnpm test:scripts` 变红。

## Testing

- `shared/tests/loopback.spec.ts`（17 项）覆盖要求的四种情形：回环套接字 + 回环 Host + 无转发头仍为本机；任一转发头使其成为远程；非回环套接字保持远程；以及空值情形，空值不得被读成「没有代理」。同时钉住浏览器标记，包括它们在直连请求上仍自行决定。
- `packages/dsh-remote-web-ui/tests/gate.spec.ts`（21 项）在 `isLoopbackClient` 上钉住同样四种情形，并钉住闸门本身：看起来像回环的被转发请求在没有设备 cookie 时被拒绝。
- `packages/dsh-remote-web-ui/tests/routes.spec.ts`（42 项）在真实 HTTP 服务器上跑真实路由族：带 `CF-Connecting-IP` 或 `X-Forwarded-For` 的 `/api/pair/issue` 与 `/api/pair/stop` 返回 403，而直连调用仍返回 200；`/api/pair/status` 拒绝被转发的调用者，而不是返回回环快照。
- 仓库门禁：改动下 `pnpm -r test`、`pnpm typecheck`、`pnpm test:scripts`（含同步漂移门禁）、`pnpm test:standards`、`pnpm i18n:check`、`pnpm emoji:check` 与 `node scripts/verify-docs.mjs` 均为绿。
