# Agent Note: 远程桥协议 v1 是与传输解耦的原生客户端面

Status: implemented

同级面的决策：[远程控制复用官方界面](2026-08-29-remote-control-reuses-official-ui.md) 拥有浏览器路径——配对设备 cookie 与受门禁的 `/remote` 通道。本 note 拥有第二条面：为原生客户端准备的、协议形状且不带 cookie 的路径。

## Problem

`dsh-remote-web-ui` 靠配对浏览器发布手机面：设备拿到 cookie，之后每次调用都走 `/remote` 通道，而该通道用进程自身的浏览器凭据重新签发。对浏览器而言这是正确的形状——它白拿了官方 UI、移动适配层与设置桥。对没有浏览器、没有 cookie 罐、也没有 Web GUI 包体的原生客户端而言，这是错误的形状：iOS App 得先模拟一个浏览器会话，而且照样继承网页的失效模式。

两条约束决定了这里「原生客户端」只能是什么样。其一，宿主没有为此准备的官方 HTTP API：从远程 origin 直接打 `/api`，受制于宿主围栏恰好信任什么，而把产品建在其上的插件会把 SDK cohort 的端点名与宿主自身的鉴权变成自己的版本耦合依赖。其二，浏览器凭据本身无法跨中继回放：它与浏览器访问过的确切 `host:port` 绑定，且没有 loopback 豁免，因此代理重发到 `127.0.0.1` 会被拒——正是 `dsh-remote-web-ui` 不得不自行兑换 launch token 才绕开的那个缺陷。

所以原生客户端需要一种宿主本来没有的传输，以及自己的访问控制。缺的是一个决策：这条面是什么、如何鉴权、与浏览器那条面是什么关系。

## Decision

- **桥是独立包，协议 v1 是独立契约。** `@linxin666/dsh-remote-bridge` 是同一插件行承载的两个半区（`packages/dsh-remote-bridge`）：宿主半区发布一条精确的 WebSocket upgrade 路由 `/ios/v1` 与一条精确的 HTTP 路由 `/remote-bridge/pair/token`，而同一行声明的浏览器半区（`dsh.client` -> `exports["./client"]`）再加一个侧栏底部的配对面板。协议是一套 JSON 信封——`{"t":"req","id","m","p"}`、`{"t":"res","id","ok","r"|"e"}`、`{"t":"ev","seq","m","p"}`、`{"t":"ping"|"pong","ts"}`——一条消息一个文本帧；方法层不出现 HTTP、cookie 或浏览器会话，因此同一套信封可以原样跑在 loopback socket、局域网绑定或被中继的 origin 上。
- **桥在进程内消费宿主。** 会话工作走 `ctx.typertGateway`（一元调用用 `invoke`，`session/follow` 用 `stream`），只以 gateway 的 `error.code` 作为失败判别，并对服务激活窗口使用家族既有的有界重试。权限请求在同一进程内监听 `ctx.on('approval/request')` 作答——绝不走 `$events`/`$events/result`——而无人应答的审批会被归一为 `unavailable`，宿主按拒绝处理，因此沉默的手机永远不等于同意。
- **桥自签 bootstrap token。** 仅 loopback 可达的 `GET /remote-bridge/pair/token` 把一枚 32 字节、30 秒有效的一次性密钥交给操作者；`pair.begin` 花掉它并签发 nonce；`pair.finish` 用所给 P-256 SPKI 验证对该 nonce 的原始 64 字节 ES256 签名，然后在 `$DSH_HOME/remote-bridge/devices.json` 落一条名册条目——公钥、SHA-256 指纹、时间戳（目录 0700、文件 0600、临时文件加原子 rename）。设备令牌本身是 32 随机字节，只保留其 SHA-256 哈希。`dsh-remote-web-ui` 不被改动：它的配对服务继续为浏览器路径签发 cookie，两份名册是两个文件，吊销互不相干。
- **浏览器半区渲染那枚 token，且从不消耗它。** 面板注册进官方 `sidebar.footer.action` 座位——ui-sidebar 声明的那个列表槽位，`dsh-remote-web-ui` 的手机触发器与 `dsh-update` 的更新器已经占用它——用同源请求读同一条仅 loopback 门禁的路由，并把密钥以 `qrcode.react` 二维码加旁边的明文呈现，配 30 秒倒计时与「重新取码」动作。二维码里装的只有裸 token：那里若放 URL 或 JSON，手机端自己的解析器会把 origin 改写成这台机器的 loopback 地址，而那恰恰是手机唯一够不到的地址。`403` 与网络失败各自渲染成有名字的状态，绝不呈现为一块沉默的面板。面板不能签发设备令牌、不能消耗配对码、不能列名册、不能吊销设备，也不新增任何 wire 面。
- **一条授权规则，在分发之前检查。** 设备令牌缺失、未知或已吊销的连接只能调三个方法（`hello`、`pair.begin`、`pair.finish`），其余一律回 `unpaired`。设备令牌随 upgrade 以 `Authorization: Bearer` 携带，也给无法设置握手 header 的客户端留了 `?token=`；比对先对两侧取哈希，再比等长摘要。
- **不做增量补发。** 连接的 event `seq` 自 1 起，给的是该连接收到的东西编号；发现跳号或重连的客户端调 `session.snapshot` 拿完整基线。`session.snapshot` 打开宿主 `session/follow` 流并保持它作为本连接的订阅，因此增量无需轮询即到达；而快照的 `lastSeq` 是宿主游标——与 `seq` 是两个计数器，协议从不比较二者。
- **中继无需改动。** 桥搭在实例本来就发布的那个 origin 上：`market/worker/src/relay.js` 查出隧道目标、只重写 `Host` header、原样返回 origin 的响应，而 WebSocket upgrade 走同一跳，因为 Workers 运行时会把携带 `Upgrade` 请求且 body 为空的 `fetch` 升级为 WebSocket。把 token 端点挡在公网 origin 之外的是 loopback 门禁，不是中继。

## Testing

协议的纯逻辑不依赖宿主即可单测：信封编解码与 256 KiB 上限、每连接序号、wire 表的参数布局、DSH 帧到 `session.delta` 的映射、审批桥的 resolve 与超时路径，以及名册读写与 ES256 验签（测试用 `node:crypto` 真造一对 P-256 密钥并签名，因此 DER 与原始形态的差异、或摘要被换掉，都会让套件失败）。浏览器半区同样如此：取码逻辑注入传输，跑遍它的 `200`、`403`、畸形响应体与不可达四种结局；面板与座位则对着注入的 props 渲染——注入的是读码器与剪贴板，而不是被打补丁的模块——所以倒计时在假时钟上断言，靠的不是 sleep。另有零依赖脚本 `packages/dsh-remote-bridge/scripts/client.mjs` 对活着的宿主跑固定序列——`hello`、`session.list`、`session.snapshot`、`session.prompt`，随后收 `session.delta` 直到三条或收到 turn-end——并能给没有 Secure Enclave 的机器用一次性 P-256 密钥完成配对。

## Alternatives considered

- **跨中继回放浏览器凭据。** 依同级 note 已落地的证据否决：宿主浏览器鉴权 cookie 与浏览器访问过的 `host:port` 绑定且没有 loopback 豁免，代理重发到 `127.0.0.1` 会被拒；`dsh-remote-web-ui` 之所以能转发调用，是因为它自行兑换过一次 launch token 并持有活着的配对设备 cookie。原生客户端两者皆无，因此这条路会迫使桥自造并持有浏览器会话——为一段用户从未打开的会话建一个凭据库。
- **给 `dsh-remote-web-ui` 加一个签发方法。** 否决：那会把两个包的生命周期绑在一起，让一条面的鉴权依赖另一条的配置与名册格式。桥的全部意义在于原生客户端不需要安装浏览器插件；同级 note 自己的边界是浏览器通道用进程凭据重发调用——那道缝不能变成通用签发器。
- **建立在官方 `/api` HTTP 面之上。** 否决：它把宿主自身的鉴权与 SDK cohort 的端点名变成桥的兼容性契约。同级 note 记录到本 cohort 上运行时并不发出 `api/gate` 缝，因此从远程 origin 直接打 `/api` 只受宿主围栏加上浏览器已兑换的那份 cookie governing——一种桥既说不清也管不住的信任姿态。
- **复用浏览器通道的 WebSocket（`/remote/api/remote.mux`）当传输。** 否决：那条 socket 是官方客户端多路复用的 Typert 连接，代理它等于把第二套协议塞进一条门禁按「已配对浏览器」定义的通道里。桥用自己那套信封，对只懂这套信封的客户端讲话。
- **把配对面板放进 `dsh-remote-web-ui`。** 否决：那个包的面板签发的是浏览器路径自己的配对链接，其凭据是配对设备 cookie——另一种密钥，生命期不同，背后的名册也不同。把本包的一次性 token 渲染到那里，会迫使两份名册与两条吊销流程保持一致，而上面划出的包边界存在的意义正是避免这种耦合；让同一侧栏座位多一个占用者，两条面就能并排放着而互不共享状态。把面板留在本包内，也让原生路径在 `dsh-remote-web-ui` 缺席时依然可用，而那正是当初造出这个桥要保住的性质。
- **缓存 delta 让重连可以增量续传。** 否决：那会把桥变成一份自带保留策略与投递保证的持久日志，而它服务的客户端群体一次完整基线调用就能恢复。snapshot 路径本就存在，也是诚实的恢复机制。

## Consequences

- 现在有两条远程面、两套互不依赖的访问控制：浏览器路径（配对 cookie、`/remote` 通道、`dsh-remote-web-ui` 的名册）与原生路径（设备令牌、`/ios/v1`、桥自己的名册）。吊销其一不吊销其二，这正是有意的分离——也是两个包的 README 各自陈述自己安全模型的原因。
- 本包现在在宿主半区旁边多了一个浏览器半区，方向是单向的：浏览器半区可以读配对路由并渲染它，不能签发、消耗、列出或吊销任何东西。它唯一的 wire 调用，是对一条浏览器配对路径从不提供的路由发起同源 `GET`。
- 桥现在除了 wire 格式还拥有 UI 文案：面板注册了 `remote-bridge` locale 命名空间，并占用 Web GUI 侧栏底部的一个座位，因此它的触发器加入家族的底部行，文案遵循仓库的 zh/en 字典纪律。
- 协议 v1 的方法集冻结为七个客户端方法加一个审批回复；桥可能调用的每个 DSH 端点的 wire 布局集中在一张表里（`src/core/wire.ts`），其中还包含三个尚无方法暴露的端点。新方法若把某个参数名写错，会在 gateway 处以 `arguments-invalid` 失败，而不是静默调错形状。
- 桥自己拥有一份持久格式：`$DSH_HOME/remote-bridge/devices.json`。它的形状从上线那天起就是兼容性面；损坏的文件被隔离待查而不是被静默清零，因此「解析失败的名册」永远不会被误当成「没有设备的名册」。
- 丢掉设备令牌的客户端用一枚新的 bootstrap token 重新配对——这是常规恢复路径而非异常路径。整个流程里没有任何一步需要手工改名册。
- token 端点只能从本机触达，同一条链接会写进宿主日志，而配对码本身渲染在配对面板里；那行日志与屏幕上那串码在其 30 秒生命期内都是活着的密钥，README 把它们写在操作者会读到的地方。
