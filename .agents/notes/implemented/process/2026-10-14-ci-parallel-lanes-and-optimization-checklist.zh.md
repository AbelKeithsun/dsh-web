# Agent Note: CI 把必需检查拆成并行通道，且 CI 改动遵循同一份清单

Status: implemented

## Problem

每一条必需检查过去都是一个串行 job。`CI checks` 把三条文本规则、类型程序、构建、整个 workspace 套件和八道一致性门禁当作单个 2m44s job 的步骤依次跑完，可这些步骤除了同一份 checkout 之外毫无共享：文本规则读的是手写源码、根本不需要依赖，一致性门禁比对的是已提交产物，套件读的是已提交的 `lib/` bundle。第二条必需检查 `plugin-mount`（2m24s）每次运行都重新下载钉版 DSH CLI——占它 32s——而任何一个 job 都可能卡在一次停滞的 `git fetch` 上直到 30 分钟超时，因为没有任何东西为 clone 设界。

仓库同样没有为那些标准 CI 问题留下过答案：更快的运行器、原生类型检查器、linter、浅层或过滤安装、依赖缓存、测试分片、跨测试文件共享模块状态。每个任务都要重新争论一遍，而一次用 runner 分钟换延迟的改动没有既定标尺可判——这在本仓尤其重要：仓库是公开的，标准 runner 分钟免费，贡献者真正感知的指标是墙钟时间。

## Decision

`ci.yml` 把必需检查拆成三条独立通道加一个汇聚 job：

| job | 名称 | 内容 |
| --- | --- | --- |
| `static-checks` | Static checks | 弹性检出、actionlint、环境安装、三条文本规则在 `pnpm install` **之前**、安装、lint、typecheck、build |
| `unit-tests` | Unit tests（`shard: [1,2,3,4]`） | 弹性检出、环境安装、依赖安装、`node scripts/test-shard.mjs <shard> 4`——不构建 |
| `consistency` | Consistency gates | 弹性检出、环境安装、依赖安装，随后 sync-shared、libs、aggregate、docs、runtime-deps 与脚本测试——从不构建 |
| `ci` | **CI checks**（名称不变） | `if: always()`，`needs` 上述三条通道，除非每个 `needs.<job>.result` 都恰好是 `success` 否则失败 |
| `plugin-mount` | （不变） | 行为不变，另加弹性检出与缓存化的钉版 DSH CLI |
| `contribution-evidence` | Validate PR contribution evidence | 不变 |

`nightly.yml` 保留它的两个 Tier-2 job，只加弹性检出；`release.yml` 保留受开关控制的发布通道，只给 `verify-release` 加弹性检出与同一套 CLI 缓存。

必需检查的名字由仓库 ruleset `integration-branch-policy` 冻结——`CI checks`、`plugin-mount`、`Validate PR contribution evidence`、`guard-agent-notes`——因此沿用旧名的是汇聚 job，而不是让三条通道变成新的必需上下文；并且聚合判断是显式写出的，不依赖 `needs` 默认语义：被跳过或被取消的通道永远不能算作满足了必需检查。

### 每一处摆放的理由

- **文本规则放在 `pnpm install` 之前。** 它们只 import Node 内置模块与本地脚本模块，而 `pnpm` 在没有 `node_modules` 的树里照样能执行脚本（已实测）。贡献者最常犯的违规因此在数秒内失败，而不是在安装与类型检查之后。
- **构建归属 `static-checks`，分片通道不构建。** 唯一读构建产物的套件（`packages/dsh-web-all`）读的是全新 clone 本来就带的已提交 `lib/` 产物，而 `libs:check` 独立地把这些产物与已提交源码绑定。实测：在一棵 `lib/` 被证明与 `HEAD` 逐字节相同的树里，十八个套件在没有构建的情况下全部通过。
- **`consistency` 从不构建。** `libs:check` 用指纹比对已提交产物与已提交源码；同一工作树里先跑构建会先把产物替换掉，恰好掩盖该检查存在的意义——那个陈旧的提交。各自独立的 job 各自拿到干净 checkout，于是这条保证不再依赖单个 job 内的步骤顺序。
- **分片是推导出来的，不是写死的。** `scripts/test-shard.mjs` 从 `pnpm-workspace.yaml` 枚举带测试的 workspace 包，按一份写入仓库的权重表做最长处理时间优先的划分。其并集恰好等于 `pnpm -r test` 覆盖的集合，互不重叠且确定，由 `pnpm test:scripts` 里的 `scripts/test-shard.test.mjs` 断言——其中一项还拿 pnpm 自己的 workspace 视图做交叉核对。权重过期只会影响均衡，永远不会影响覆盖。
- **每个分片同时跑两个套件。** 每个套件运行器本身已经摊开到多个核上，因此在四 vCPU runner 上限制并发中的套件数是在约束超订；这也与覆盖率门禁早已采用的「有界并发、上限二」约定一致。
- **弹性检出。** 第一次尝试限时三分钟并允许失败，失败时删掉半个 `.git`，再以五分钟上限重试一次。这段步骤在每个检出的 job 里原样内联，因为 `timeout-minutes` 不是 composite action 步骤的合法键（官方 metadata 语法；[actions/runner#1979](https://github.com/actions/runner/issues/1979)），无法抽成一个共享 action。
- **一个版本只有一个家。** 每个 workflow 只声明一次 `DSH_CLI_VERSION`，缓存 key 与安装命令都读它：如果安装行改了版本而 key 没改，缓存会恢复旧前缀、存在性判断会跳过安装、mount 冒烟就会静默挂载上一个 CLI。
- **CLI 解析守卫。** `dsh` 不在 `PATH` 上时 `scripts/e2e-mount.sh` 会退回 `npx -y --package @deepseek-ai/dsh`，那等于测试一个未钉版的 CLI；现在有一道步骤在 `dsh` 未解析到缓存前缀时直接失败，因此布局变化无法再悄悄削弱冒烟。
- **原生类型检查。** 十五个包的 typecheck 程序改由 `tsgo`（原生编译器）执行，逐包验证与 `tsc` 给出相同 program 集合与相同结论。三个 `typecheck` 为 `tsc -b` 的包保留 `tsc`：build 模式会产出，tsgo 的产出并非逐字节相同（打印器引号风格），其 `tsbuildinfo` 也无法被构建里的 `tsc -b` 复用，因此切换它们让构建慢掉的比 typecheck 赚到的更多。

### CI 优化清单

每次 CI 改动都要说明它推进了哪一条，或者说明该条为何在此不适用。编号对应本仓采用的这份清单。

| # | 条目 | 结论 |
| --- | --- | --- |
| 1 | 更快的运行器 | **不适用。** 公开仓库 + 免费个人账户：标准 runner 免费，更大的 runner 需要 Team 或 Enterprise Cloud 的组织，且无论仓库可见性都按分钟计费。只有拿到组织计划才重议。 |
| 2 | 原生类型检查器 | **已落地。** 十五个包改用 `tsgo`；本机热态 `pnpm typecheck` 由 7.66s 降到 2.63s。 |
| 3 | 去掉类型信息的 lint 规则 | **已落地。** 门禁集合本来就是不需要类型程序的语法级脚本；Oxlint 作为 linter 加入，按 correctness、suspicious、perf 三类配置，这三类都不需要类型信息。 |
| 4 | Oxlint | **当前先只报告。** 静态通道运行 `pnpm lint`，且该步骤容忍非零退出。扫描覆盖 966 个手写文件，报告 37 条规则下的 892 处发现——远超一次 CI 改动所能修完并验证的规模——因此该步骤只报告数量、不阻断。四条规则带原因关闭：`unicorn/no-array-sort`（类型程序钉的是 `lib: ["ES2022", …]`，`Array#toSorted` 属 ES2023，且仓库里没有调用点）、`eslint/no-underscore-dangle`（命中的全是 `__` 前缀的全局量或构建占位符，而该规则针对的是成员访问）、`unicorn/require-module-specifiers` 与 `import/no-empty-named-blocks`（都命中仓库既有的环境增强写法 `import type {} from '<pkg>'`）。后续计划：按规则分诊，先修缺陷形态的大头（`no-await-in-loop` 189、`consistent-function-scoping` 167、`no-unused-vars` 112、`promise/always-return` 75、`no-shadow` 75），然后把该步骤转为阻断；或者采用 `scripts/test-standards.mjs` 已在用的基线棘轮，让逐文件发现数只减不增。 |
| 5 | 更轻量的检出 | **本来就满足。** `actions/checkout` 默认 `fetch-depth: 1`，十六个 workflow 里有十一个根本不检出，只有 `release.yml` 要完整历史（它生成 release notes 时回溯到上一个 tag）。 |
| 6 | 弹性检出 | **已落地。** `ci.yml`、`nightly.yml`、`release.yml` 的每一次检出都有限时首试加一次重试。 |
| 7 | 把缓存写入移出关键路径 | **本来就满足。** `setup-node` 的 pnpm store 保存与 `actions/cache` 的保存都发生在 job 收尾阶段，没有通道在等缓存写入。 |
| 8 | 在 CI 镜像里预安装 | **按字面不适用**——本仓不构建 CI 镜像。它的对应物已落地：钉版 DSH CLI 从缓存恢复而不是重装（32s → 约 2s）。 |
| 9 | 过滤安装 | **不适用。** 每条通道都需要完整 workspace 依赖图（`pnpm -r typecheck`、`-r test`、构建），而热缓存下安装只要 3s；过滤只会引入第二种解析方式，却不能让任何门禁少需要依赖。 |
| 10 | 移除昂贵的缓存 | **评估后保留。** 这一条的规则是「保留缓存前先测量」；本仓实测热 pnpm store 把安装变成 3s，因此缓存是收益而不是该条目所针对的负担。 |
| 11 | 用模式快照替代迁移重放 | **不适用。** 没有任何通道启动数据库或重放迁移。 |
| 12 | 批量小检查 | **已落地，方向相反。** 八道一致性步骤早已批量在同一个 job 里；由于本仓标准分钟免费，取舍方向是反的——用一个冻结的必需上下文，让真正独立的重活跑成并行通道。四分片通道加汇聚 job 让一次运行共九个 job 记录，这也是我们不再拆第五条通道（用于构建）的预算考量。 |
| 13 | 均衡分片 | **已落地。** 按实测权重表分四个分片（各分片权重 29/30/29/30s，总计 118s），最重的套件不再互相排队。 |
| 14 | 跨测试文件共享模块状态 | **不落地。** vitest 的逐文件隔离是这些套件的正确性边界，而 workspace 套件本就处在 Tier-1 预算之内；本仓等价的收益来自分片墙钟。套件超出预算时再议。 |
| 15 | 越过设置成本边界继续分片 | **已落地。** 每条通道的设置约 12s，一个分片只多付一次检出、一次环境安装与一次依赖安装，而必需检查的墙钟现在由静态通道而非套件决定。 |

## Alternatives considered

- **保留单 job、只调步骤**（把文本规则前置、提高测试并发）：否决，因为步骤彼此独立，串行本身就是最大成本；那样类型程序、构建与套件依旧互相排队。
- **给三条通道各自命名并把三者都设为必需上下文**，同时改 ruleset：否决，那会把一次仓库设置写入变成此后每次 CI 改动的一部分，并让需要同步的上下文成倍增加；汇聚 job 让公开契约稳定在一个名字上。
- **用 matrix 表达三条通道而不是独立 job**：否决，因为每条通道需要自己的超时与自己命名的失败步骤，而 matrix 的一个 leg 表达不了这些差异。
- **把弹性检出做成 composite action**：依据证据否决——`timeout-minutes` 不在 composite 步骤的合法键里，而让重试有意义的正是这个超时。
- **分片超过四个，或单独为构建开一条通道**：否决，因为必需检查的墙钟现在由静态通道界定，多开 job 只会增加并发压力（免费账户的 job 预算）而不会缩短检查。
- **三个 `tsc -b` 包也切到 `tsgo`**：依据实测否决——typecheck 的收益（914/1191/645ms 降到 212/315/181ms）小于构建在缓存无法复用后的损失（121/120/118ms 涨到 973/1215/657ms），而且产出字节会改变。
- **移除 pnpm store 缓存**：依据实测否决；热态安装是 3s。
- **用 `isolate: false` 跨测试文件共享模块状态**：否决——套件规模太小，墙钟收益不足以抵偿当前由隔离排除掉的跨测试污染风险。

## Consequences

必需检查的墙钟现在是 `max(静态通道, 最慢分片, 一致性通道) + 汇聚`，而不是各门禁耗时之和，因此新增一道门禁不再线性拉长检查。代价是 runner 分钟：一次运行九个 job 记录而不是三个。这在公开仓库的标准 runner 上免费，但在私有 fork 上是真实开销——该取舍只在当前前提下成立，一旦仓库转为私有就需要重议第 12 条。

汇聚 job 自身不报告任何门禁细节，因此读者必须点开各通道才能知道哪道门禁失败；各通道正因如此保留了自己命名的步骤。某个套件实质变化后需要重新测量 `scripts/test-shard.mjs` 的权重，但权重过期只会让分片失衡，绝不会让某个包从运行中被丢掉。

新的 lint 门禁已经产出真实发现：`shared/tsdown.client.ts` 在非数组类型上写了 `readonly` 修饰符（TS1354），位于第 131 与 168 行；而 `shared/tsconfig.json` 只 include 了 `client`、`host`、`core`、`types`，因此类型程序从未检查该文件。该错误当下是惰性的（编译器忽略该修饰符、打包器剥掉类型），因此不在本次改动里顺手修——修它会把一个构建预设的编辑和一整轮 `libs:write` 产物刷新拖进一次 CI 改动；它属于另一项把类型程序覆盖到 shared 根目录的改动。

## Testing

改动落地前的本地验证：`pnpm typecheck`、`pnpm test:standards`、`pnpm i18n:check`、`pnpm emoji:check`、`pnpm docs:check`、`pnpm sync-shared:check`、`pnpm libs:check`、`pnpm aggregate:check`、`pnpm runtime-deps:check` 与 `pnpm test:scripts` 全部通过；`scripts/test-shard.test.mjs` 15/15 通过，其中包含对 pnpm 自身 workspace 视图的覆盖完整性交叉核对，四次 dry run 把全部十八个包各分配一次，权重 29/30/29/30s。「无构建」实验（一棵 `lib/` 被证明与 `HEAD` 逐字节相同的临时树）在完全不构建的情况下跑绿了四个分片。重构后 `/opt/homebrew/bin/actionlint` 对全部十五个 workflow 报告零问题。四个分片在空闲机器上端到端跑完，墙钟分别为 15.1s、12.4s、12.3s、14.6s，十八个包全绿；`pnpm lint` 按设计报告 892 处发现并以非零码退出，静态通道的步骤容忍这一点。

无界的 `pnpm -r test` 路径对负载敏感：在满负荷并行下，它先后在 `dsh-task-board` 与 `dsh-liangshen` 上撞到 5 秒测试超时。两个包在单独运行与有界分片运行里都通过，且这些失败复现的正是覆盖率门禁的「有界并发」与本通道分片并发所要约束的行为；本次工作没有改动任何源码或测试文件。
