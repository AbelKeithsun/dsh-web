# Agent Note: ZIP 测试直接消费市场生产写入器而非副本

Status: proposed

## Problem

[ZIP 回归套件](../../../../scripts/market-zip.test.mjs#L12-L70) 自带一份 `zipStore` 实现，[生产写入器](../../../../scripts/market-build#L673-L740) 则独立维护。生产头部偏移损坏后，测试仍可能通过，因为它运行的是复制实现而非真正生产字节的 owner。这不是独立 oracle，两份函数实现的是同一个序列化器。

## Proposal

把既有纯写入器移到脚本库中的一个小型 CommonJS helper，由构建 require，ZIP 测试也导入同一个 helper。删除测试侧写入器，保留独立 ZIP 解析器及字段/内容断言。使用 Node 既有 `crc32`，保留确定性的 stored-ZIP 字节、UTF-8 标志、文件模式、时间戳、顺序和偏移。不新增归档依赖或第二个序列化器。

helper 不包含市场扫描或顶层构建执行。两份合成目录 fixture 要将它复制到构建脚本旁；这是残余胶水而非另一份实现。不需要改市场目录、安装器、vendor shell 或已发布 API。

## Context & Efficiency Impact

删除重复的序列化器定义及其维护义务；生产定义仅迁移归属，行为不变。替代成本是两个导入点及 fixture 复制条目。提示词/工具 schema 开销不变。序列化器及现有格式限制仍由仓库维护，不静默增加 ZIP64、压缩或通用归档框架。

## Evidence and ownership

- 生产[产物生成](../../../../scripts/market-build#L577-L585) 调用 `zipStore` 写每款皮肤的下载归档，[try-on 客户端](../../../../market/shell/packages/dsh-web-tryon/src/client.tsx#L239) 链接到这些交付 ZIP。这是生产机制，不是仅供测试的 helper。
- 测试明言为避免导入非模块脚本而内联相同写入器。独立的[头部解析器](../../../../scripts/market-zip.test.mjs#L72-L129) 和七个结构/内容场景应保留，只删除复制的生产者。
- [干净检出 fixture](../../../../scripts/market-build-clean.test.mjs#L37-L65) 已复制一个兄弟脚本。[容量 fixture](../../../../scripts/market-build-cap.test.mjs#L26-L50) 当前只复制构建脚本，需一并复制新 helper。它们是真实的脚本打包消费方，不是保留重复实现的理由。
- 搜索活跃 proposed/implemented/rejected 记录，未发现 ZIP 写入器 owner 或重叠提案。不取代已有记录。另有[归档比较豁免](../../../../scripts/market-build#L876-L887)，在 shell 构建缺失时跳过 ZIP；尚未确定其意图，因此明确不在本提案中改动。

## Alternatives considered

保留复制写入器并增加等值门禁：否决，因为仍要维护两份定义及同步规则。共同导入一份实现即可删除这项义务。

测试用 regex/eval 提取函数文本：否决，因为测试会依赖源码拼写，且仍不验证生产打包边界。

从整个构建脚本导出函数并保护 `main`：可行但不首选，因为导入时仍执行模块级路径/资产解析。小型纯 helper 以两份 fixture 复制条目为成本隔离真正的契约。

保持副本不动：最强理由是 fixture 构建自包含，但这个优点不足以支持虚假的回归保证；兄弟文件打包已经是干净 fixture 的契约。

## Acceptance criteria

- 生产构建与 ZIP 测试消费同一份写入器，不保留复制序列化器或源码提取适配器。
- 对代表性的空归档、多文件、二进制和 UTF-8 归档保留逐字节输出；保留独立解码及提取断言。
- 临时在生产 helper 中引入偏移故障，必须使 ZIP 回归套件失败；提交前恢复故障。
- 两份合成目录 fixture 在 helper 随构建脚本打包后正常运行；`pnpm test:scripts` 和仓库基线门禁通过。
- 在钉版输入下 `pnpm market:check` 通过，完整实施构建不改变已提交归档字节。提交中不带无关市场重建输出。
- 归档比较豁免保持不变，除非另有以证据支持的决策确定删除它。

## Risks

复制脚本的 fixture 或部署若遗漏 helper，会在写入器执行前失败。迁移导入不慎会让单测执行整个市场构建。独立解析器才是 oracle，不能用同一写入器逻辑生成的断言替代。
