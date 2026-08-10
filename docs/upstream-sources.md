# 本地上游源码工作流

## 目的

Codex 协议、微信和飞书开发优先使用项目内已经固定版本的上游源码，避免每次重复联网搜索，也避免把变化中的
远端 `main` 当作当前协议事实。上游仓库位于主项目的 `upstream/` 目录，由 `.gitignore`
整体忽略，各自保留独立 Git 历史，不进入 `codex-channels` 提交或 npm 包。

本页只规定源码查阅和更新方式；渠道公开范围与真实验收以
[`通讯渠道验收矩阵`](channel-acceptance-matrix.md) 为准，微信上游边界见
[`微信 Surface 设计决策`](weixin-surface-plan.md)，飞书资料基线见
[`飞书官方资料与实现索引`](feishu-reference-index.md)。

## 当前锁定基线

| 用途 | 本地目录 | 官方仓库 | 当前基线 |
| --- | --- | --- | --- |
| Codex CLI、Core 与 App Server 协议行为 | `upstream/openai-codex` | `openai/codex` | `rust-v0.147.0`，提交 `be6e8eac029b183056b7e4402879f15d2c85f61b` |
| 微信 ClawBot HTTP、消息和媒体合同 | `upstream/openclaw-weixin` | `Tencent/openclaw-weixin` | `v2.4.6`，提交 `cef0bfc390393f716903e16d50408118047f87e0` |
| 飞书官方 Node SDK | `upstream/larksuite-node-sdk` | `larksuite/node-sdk` | `@larksuiteoapi/node-sdk@1.71.1`，提交 `8b3e0df3af9401c263dc96026e1c7f17460a21cc` |
| 飞书官方 OpenClaw 插件参考 | `upstream/openclaw-lark` | `larksuite/openclaw-lark` | 提交 `dde0be3680d6fd5443cab426c8f4b3216266346a` |

飞书协议和 API 字段以官方 Node SDK及飞书开放平台为主要事实来源；OpenClaw 插件只用于参考渠道
编排、授权、卡片、媒体和错误处理，不替代官方 SDK。微信未发布独立 SDK，固定版本官方插件的
源码、类型和测试是协议研究基线，真实合同仍以本项目的脱敏探针结果为准。

## 查阅顺序

1. 先读取本页和对应 Surface 的资料索引。
2. 检查目标本地仓库的 HEAD 是否等于上表基线。
3. 优先用 `rg`、`sed` 和仓库内测试查找固定版本行为。
4. 再核对本项目的公开接口、实现与测试。
5. 只有本地资料缺失、需要动态开放平台文档或准备升级时才联网。

本地仓库存在且基线正确时，不应为了相同源码内容调用网页搜索。不得从本地上游仓库导入运行时代码
或建立构建依赖；它们只是审查资料。

## 首次准备

新工作区没有 `upstream/` 时，按当前锁定基线显式克隆：

```text
git clone --depth 1 --branch rust-v0.147.0 https://github.com/openai/codex.git upstream/openai-codex
git clone --branch v2.4.6 https://github.com/Tencent/openclaw-weixin.git upstream/openclaw-weixin
git clone https://github.com/larksuite/node-sdk.git upstream/larksuite-node-sdk
git -C upstream/larksuite-node-sdk checkout 8b3e0df3af9401c263dc96026e1c7f17460a21cc
git clone https://github.com/larksuite/openclaw-lark.git upstream/openclaw-lark
git -C upstream/openclaw-lark checkout dde0be3680d6fd5443cab426c8f4b3216266346a
```

克隆或更新需要网络和明确授权。不得因为目录缺失而在任务中静默下载。

## 日常更新与升级

正常开发期间不自动更新。只有用户要求升级或项目锁定版本变化时：

1. 在目标上游仓库执行 `git fetch --tags origin`。
2. 比较当前锁定提交与候选 Tag/Commit，审查源码、类型和测试差异。
3. 在隔离分支完成本项目适配和真实合同验证。
4. 同步更新本页、对应 Surface 资料索引、实现、测试和公开支持说明。
5. 验证通过后再把本地上游仓库切到新的固定提交。

上游仓库保持只读，不在其中创建项目补丁、提交或向官方远端推送。需要借鉴实现时应在
`codex-channels` 的模块边界内重新实现最小能力，并保留本项目自己的安全约束。
