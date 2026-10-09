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
| Codex CLI、Core 与 App Server 协议行为 | `upstream/openai-codex-0.160.1` | `openai/codex` | `rust-v0.160.1`，提交 `d27764b82f7118f674371e6d6e76271d9d606edb` |
| 微信 ClawBot HTTP、消息和媒体合同 | `upstream/openclaw-weixin` | `Tencent/openclaw-weixin` | `v2.4.9`，提交 `43675b66551d12d6853155a7869a50fb12a18a1e` |
| 飞书官方 Node SDK | `upstream/larksuite-node-sdk` | `larksuite/node-sdk` | `@larksuiteoapi/node-sdk@1.74.0`，提交 `394c83092395a51402ee408b751d7f9fb05f5518` |
| 飞书官方 OpenClaw 插件参考 | `upstream/openclaw-lark` | `larksuite/openclaw-lark` | 提交 `dde0be3680d6fd5443cab426c8f4b3216266346a` |

飞书协议和 API 字段以官方 Node SDK及飞书开放平台为主要事实来源；OpenClaw 插件只用于参考渠道
编排、授权、卡片、媒体和错误处理，不替代官方 SDK。微信未发布独立 SDK，固定版本官方插件的
源码、类型和测试是协议研究基线，真实合同仍以本项目的脱敏探针结果为准。

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

Relay 与 CLP Codex 目录共用下载器读取 [Cline 官方模型文件](https://github.com/cline/cline/blob/c269dbb7f97256d53d4aedabb6c245b9ec54b1b6/sdk/packages/llms/src/catalog/catalog.generated.ts)，
首次解析格式审查基线为 `c269dbb7f97256d53d4aedabb6c245b9ec54b1b6`，未建立本地源码仓库。
同时核对该提交的 `catalog-cline-recommended.ts`、`scripts/generate-models.ts` 和共享 `reasoning-options.ts`；输入类型映射核对同一提交的 `providers/model-capabilities.ts` 与 `catalog/catalog-live.ts`。
思考参数映射另核对同一提交 `providers/routing/portable-reasoning.ts`、`providers/routing/anthropic-compatible.ts`、`providers/routing/provider-option-rules.ts`、`providers/vendors/cline.ts` 及相邻测试；Cline/Cline Pass 共用 `cline` SDK 适配器，通用关闭为 `reasoning.enabled=false`。锁定依赖 `@ai-sdk/openai-compatible@3.0.37` 的 [Chat 出站映射](https://github.com/vercel/ai/blob/%40ai-sdk%2Fopenai-compatible%403.0.37/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts)将指定等级序列化为 `reasoning_effort`。本项目保留已实测的精确 DeepSeek 关闭字段，不据此复制其他原生提供商适配器。
此处是可由用户显式更新的模型元数据，不是 Codex 协议基线；每次下载记录实际 SHA，不加载上游代码。
开关启用语义另核对本机目录记录的提交 `cd80a20e96481f5f5d413789f6847accf846487b`：`providers/routing/provider-option-rules.ts` 的 Cline 规则调用 `providers/routing/anthropic-compatible.ts` 中的 `buildGatewayReasoningOptions`，保留显式 `enabled: true/false`。目录中的 `toggle` 投影为 Codex `none/enabled`，不虚构上游思考等级；该投影不更改独立 Relay 的参数保留合同。
下载入口为 `runtime/cline-relay-catalog-update.mjs`，共用读取入口为 `runtime/cline-relay-catalog.mjs`；
Relay 更新和回退见[Relay 模型设置](provider-api-relay-development.md#clp-转发模型目录与设置)；CLP Codex 目录由独立的[共享目录更新入口](cline-pass.md)显式生成，双方不隐式覆盖彼此目录。

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
git clone --depth 1 --branch rust-v0.160.1 https://github.com/openai/codex.git upstream/openai-codex-0.160.1
git clone --branch v2.4.9 https://github.com/Tencent/openclaw-weixin.git upstream/openclaw-weixin
git clone https://github.com/larksuite/node-sdk.git upstream/larksuite-node-sdk
git -C upstream/larksuite-node-sdk checkout 394c83092395a51402ee408b751d7f9fb05f5518
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
