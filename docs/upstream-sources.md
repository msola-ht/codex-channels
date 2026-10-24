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

| 用途 | 本地目录 | 来源仓库 | 当前基线 |
| --- | --- | --- | --- |
| Codex CLI、Core 与 App Server 协议行为 | `upstream/openai-codex-0.164.0` | `openai/codex` | `rust-v0.164.0`，提交 `6aaac694803004a63c6f393d153c96d22521a6b9` |
| 微信 ClawBot HTTP、消息和媒体合同 | `upstream/openclaw-weixin` | `Tencent/openclaw-weixin` | `v2.4.9`，提交 `43675b66551d12d6853155a7869a50fb12a18a1e` |
| 飞书官方 Node SDK | `upstream/larksuite-node-sdk-1.75.0` | `larksuite/node-sdk` | `@larksuiteoapi/node-sdk@1.75.0`，公开源码提交 `e34a66f0d20935ee77f94909d16d93292d58b6c7`；发布包核对边界见飞书资料索引 |
| 飞书官方 OpenClaw 插件参考 | `upstream/openclaw-lark` | `larksuite/openclaw-lark` | 提交 `dde0be3680d6fd5443cab426c8f4b3216266346a` |

飞书协议和 API 字段以官方 Node SDK及飞书开放平台为主要事实来源；OpenClaw 插件只用于参考渠道
编排、授权、卡片、媒体和错误处理，不替代官方 SDK。微信未发布独立 SDK，固定版本官方插件的
源码、类型和测试是协议研究基线，真实合同仍以本项目的脱敏探针结果为准。

本机 `upstream/openai-codex-0.164.0` 已核对为上述固定提交，工作树干净。
其他机器缺少该目录时使用固定 Tag 链接，不能拿旧副本冒充当前基线。

## Codex 0.164.0 同步记录

已按授权把官方 `rust-v0.164.0` 完整源码及随仓文档同步到独立目录
`upstream/openai-codex-0.164.0`，固定提交
`6aaac694803004a63c6f393d153c96d22521a6b9`，核对时工作树干净。
官方 Release 发布于 2026-10-23 04:48:10 UTC，非 Draft、非 Pre-release。
生成协议、公开 CLI 合同和当前源码开发基线已同步为 `0.164.0`；旧 `0.163.0` 目录保留为历史比较来源。
本轮未替换全局 CLI 或重启、部署运行服务，源码基线不代表正在运行的共享服务版本。

- [正式 Release](https://github.com/openai/codex/releases/tag/rust-v0.164.0)。
- [固定版 App Server 文档](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server/README.md)：本地对应同名路径；与 `0.163.0` 内容相同，不能因此推断协议未变。
- [固定版协议定义](https://github.com/openai/codex/tree/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-protocol/src)。
- [升级决策](codex-cli-upgrade-decisions.md#01640-升级决策)：采用范围、关联业务适配和验收限制。

比较起点为此前固定的 `0.163.0`。本地两份固定源码可完整比较，不依赖 GitHub Compare API
最多返回 300 个文件的列表。实验协议与公开命令合同已由隔离安装的精确目标 CLI 重新生成；
生成结构不自动扩大 Gateway 支持范围，行为观察与未验证边界以升级决策及支持矩阵为准。

## 历史比较来源：Codex 0.163.0

已按授权将官方 `rust-v0.163.0` 的完整源码及随仓文档同步到独立目录
`upstream/openai-codex-0.163.0`，固定提交
`83086188ae0614bd882818ff1aa23f3194962012`。官方 Release 发布于
2026-10-15 21:30:38 UTC，非 Draft、非 Pre-release。
旧基线 `upstream/openai-codex-0.162.1`（提交 `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`）保留，
两个目录均只作只读参考。源码基线同步不表示已部署到正在运行的共享服务。

- [正式 Release](https://github.com/openai/codex/releases/tag/rust-v0.163.0)。
- [固定版 App Server 文档](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/README.md)：本地对应 `upstream/openai-codex-0.163.0/codex-rs/app-server/README.md`。
- [固定版协议定义](https://github.com/openai/codex/tree/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src)：本地对应同名路径。
- [升级决策](codex-cli-upgrade-decisions.md)：采用范围、收益边界与验收限制。

比较起点是升级前项目锁定的 `0.162.1`，不是 Release 页面所链接的 `0.162.0`。
生成类型和 CLI 合同由隔离安装的精确版本生成；未升级全局 CLI 或运行服务，
也不把在线滚动文档当作固定版合同。

## Windows 主配置与沙箱权限

固定 Codex 0.160.1 的 [`write_atomically`](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/utils/path-utils/src/lib.rs#L144) 在父目录创建临时文件后替换目标，不复制旧文件 ACL。
Windows 沙箱的 [`apply_read_acls` 调用](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/setup_provisioning.rs#L677) 配置可继承的读取与执行权限，Codex Home 不在默认敏感目录排除列表中。
因此共享主配置只校验所有权和写入完整性，不能把只读继承直接判成凭据泄漏；该检查也不证明内容机密性。独立 Provider Profile、备份及 Gateway 私有文件仍执行严格私有校验。不得按 `CodexSandboxUsers` 组名全局放行，也不接管上游沙箱账户与凭据管理。
固定模式自定义 Provider 的 API Key 使用独立私有版本文件，主配置只保存 `env_key`；既有明文配置须经用户显式编辑转换，不能以共享 ACL 检查通过证明密钥安全。Windows 原生目录句柄与 Job 归属分别参考固定版 `windows-sandbox-rs/src/no_reparse_dir.rs`、`utils/pty/src/win/job.rs`；本项目只借鉴语义，不运行或导入上游源码。
锁定版 `config/src/shell_environment_policy.rs` 默认继承全部环境且跳过默认凭据过滤；`protocol/src/shell_environment.rs` 在过滤后应用 `set`。受管 App Server 因而使用本次启动的随机凭据环境名，并以最高层命令行 `shell_environment_policy.set` 将工具 shell 的同名值覆盖为空，不依赖默认 `KEY/TOKEN` 过滤，也不替换用户已有的 `filters`、`exclude` 或 `include_only`。

`CODEX_HOME` 的解析遵循同一固定提交的 `codex-rs/utils/home-dir/src/lib.rs`：显式路径必须存在且为目录，并规范化；未设置时使用默认路径且不要求预先存在。Windows 服务安装将显式路径保存在服务环境中，防止计划任务与安装终端使用不同目录。

Windows 构建方式参考锁定 Codex 的 `codex-cli/bin/codex.js`：按平台加载预构建程序，系统调用实现位于编译后的 Rust 模块。项目沿用构建阶段生成原生产物、运行时只加载的原则，使用现有 PowerShell 7 编译本项目 C# DLL，不导入上游二进制内部接口。Job 约束仍对照 `codex-rs/utils/pty/src/win/procthreadattr.rs` 的原子 Job 绑定；构建方式调整不放宽进程或目录权限。

## 模型转发实现参考

经用户授权保留 `upstream/CLIProxyAPI`，来源为 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)，
固定正式版 `v8.0.16`，提交 `a2976eb8a303f11b4ea5177bce9f9ff752634dfc`，许可证 MIT。该第三方实现不是 CLP 官方合同，
不导入运行时代码、不运行安装脚本，不自动更新；目录沿用 `upstream/` 忽略规则。
重点参考 `sdk/api/handlers/openai/openai_handlers.go`、
`internal/translator/openai/openai/chat-completions/openai_openai_request.go` 及其测试、
`internal/runtime/executor/helps/openai_compat_max_tokens.go` 及其测试。
Chat→Chat 转换保留请求字段；长度字段归一化由模型配置显式控制，不据此推断 CLP 支持全部字段。

首次准备可执行 `git clone https://github.com/router-for-me/CLIProxyAPI.git upstream/CLIProxyAPI`，
随后 `git -C upstream/CLIProxyAPI checkout a2976eb8a303f11b4ea5177bce9f9ff752634dfc`。
TTFT 参考 `internal/runtime/executor/helps/responses_ttft_helpers.go`、`chat_ttft_helpers.go` 和 `usage_helpers.go`；本次版本更新的 Chat/Responses 内容事件判定未变。CPA 的终态及首包兜底不等于本项目的严格首内容口径，不能直接作为本地支持合同。

## Cline 模型目录来源

CLP 不再使用 Cline 官方生成目录作为模型名单或能力来源。固定 DS 模型由仓库 `runtime/model-catalog-deepseek.json` 和 `provider-model-catalog.json` 的明确映射生成，入口为 `scripts/provider-model-catalog.mjs`；其他模型通过统一的按 ID 添加入口独立声明或继承本地快照。渠道和 Relay 共用受管目录；旧独立 Relay 文件及 Cline 来源记录保留，不自动迁移或删除，见[CLP 配置与恢复](cline-pass.md)。

Cline 官方 SDK 仍是 Chat 参数语义的参考，而非模型能力验收结论。曾核对提交 `c269dbb7f97256d53d4aedabb6c245b9ec54b1b6` 的 `providers/routing/portable-reasoning.ts`、`anthropic-compatible.ts`、`provider-option-rules.ts` 和 `providers/vendors/cline.ts`。锁定的 `@ai-sdk/openai-compatible@3.0.37` 将指定等级序列化为 `reasoning_effort`；通用开关使用 `reasoning.enabled`。另核对提交 `cd80a20e96481f5f5d413789f6847accf846487b` 中保留显式 `enabled: true/false` 的规则。手填 `none/enabled` 仅用于 CLP 明确声明的开关能力，不虚构其他等级。

上述源码证明请求字段被适配器保留，不证明云端停止内部推理。Flash 请求格式由保存的 `cline_request_profile` 明确选择；未保存时仅精确原 Flash ID 使用历史默认映射。实际路由、思考正文和推理 Token 的受限观察及其限制见[CLP 文档](cline-pass.md)。

### CPAMP 指标展示参考

经用户授权保留 `upstream/CPA-Manager-Plus`，来源为 [seakee/CPA-Manager-Plus](https://github.com/seakee/CPA-Manager-Plus)，
固定提交 `fb3e8f501f47a29b0fa66a5bf31f0f36739750d3`，许可证 MIT。仅供首 Token、请求耗时与 TPS 展示口径对照，
不导入运行时代码、不安装或运行上游依赖、不自动更新。指标公式及回归用例见
`apps/web/src/features/monitoring/model/eventRows.ts` 和相邻 `eventRows.test.ts`；首 Token 采集需同时核对实际 CPA 后端版本。

## 查阅顺序


1. 先读取本页和对应 Surface 的资料索引。
2. 检查目标本地仓库的 HEAD 是否等于上表基线。
3. 优先用 `rg`、`sed` 和仓库内测试查找固定版本行为。
4. 再核对本项目的公开接口与实现。
5. 只有本地资料缺失、需要动态开放平台文档或准备升级时才联网。

本地仓库存在且基线正确时，不应为了相同源码内容调用网页搜索。不得从本地上游仓库导入运行时代码
或建立构建依赖；它们只是审查资料。

## 首次准备

新工作区没有 `upstream/` 时，按当前锁定基线显式克隆：

```text
git clone --depth 1 --branch rust-v0.164.0 https://github.com/openai/codex.git upstream/openai-codex-0.164.0
git clone --branch v2.4.9 https://github.com/Tencent/openclaw-weixin.git upstream/openclaw-weixin
git clone https://github.com/larksuite/node-sdk.git upstream/larksuite-node-sdk-1.75.0
git -C upstream/larksuite-node-sdk-1.75.0 checkout e34a66f0d20935ee77f94909d16d93292d58b6c7
git clone https://github.com/larksuite/openclaw-lark.git upstream/openclaw-lark
git -C upstream/openclaw-lark checkout dde0be3680d6fd5443cab426c8f4b3216266346a
```

克隆或更新需要网络和明确授权。不得因为目录缺失而在任务中静默下载。

## 日常更新与升级

正常开发期间不自动更新。只有用户要求升级或项目锁定版本变化时：

1. 在目标上游仓库执行 `git fetch --tags origin`。
2. 比较当前锁定提交与候选 Tag/Commit，审查源码、类型和测试差异。
3. 在隔离分支完成本项目适配和真实合同验证。
4. 同步更新本页、对应 Surface 资料索引、实现和公开支持说明。
5. 验证通过后再把本地上游仓库切到新的固定提交。

上游仓库保持只读，不在其中创建项目补丁、提交或向官方远端推送。需要借鉴实现时应在
`codex-channels` 的模块边界内重新实现最小能力，并保留本项目自己的安全约束。
