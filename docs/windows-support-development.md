# Windows 开发预览与发布门槛

## 当前结论

Windows 当前属于开发预览，不是公开正式支持平台。PowerShell 7 源码安装、前台运行、当前用户
计划任务服务、私有 IPC/文件、凭据保护和部分 CI 已经落地；完整 Windows 门禁、固定版本真实
App Server 合同与发布候选的渠道/Provider 验收仍未闭环。公开安装口径以
[源码安装与更新](source-install.md)为准，协议版本以[协议索引](index.md)为准。

根目录平台徽章使用 `Windows Preview`，不得把安装器可运行或单项实机通过解释为正式支持。

## 已落地边界

- `WindowsProxyTransport` 通过固定 Codex CLI 的 `codex app-server proxy --sock` 接入 App Server
  UDS；Unix 继续使用原有私有 Socket 合同。
- 开发中的 Desktop App 桥只绑定回环地址并要求私有随机令牌，每个连接仍通过
  `WindowsProxyTransport` 接入同一私有 UDS；它不把 App Server 改为 TCP 监听，也不替换固定
  Transport。公开 `desktop-app` 命令只读查询当前用户 `OpenAI.Codex` 包和兼容入口，`open` 直接
  创建只继承本次共享端点的包内 Desktop 子进程，不写持久环境。macOS 已确认该方案可以共享
  Thread，受管 Host 也已通过真实启动验证并把 Desktop 私有 `CODEX_APP_TOOLS_PIPE_PATH` 传给
  外部 App Server；Windows 不能沿用 macOS 的会话与内置 `codex_app` MCP 结果推断工具兼容。
  Windows 真实双向互通和内置工具均尚未验收，因此状态明确保留为预览，不视为正式平台支持。
- Gateway Owner、App Server Supervisor、Provider Metrics 与 Thread Writer Lock 使用当前用户
  私有 IPC；Windows 路径按当前 SID/ACL 校验，不套用 POSIX UID、mode 或文件类型判断。
- 配置、数据库、日志、媒体、备份和安全记录使用当前用户私有 ACL；渠道和 Provider 凭据使用
  Windows 安全记录边界，不写入 TOML、日志或业务数据库。
- `install.ps1`、源码更新、当前用户计划任务服务和 PowerShell 服务宿主已经接入统一 CLI；服务
  不要求管理员权限，也不得改变 Unix 服务语义。
- GitHub Windows Job 当前执行依赖安装、构建、类型检查、文档检查、PowerShell 语法、CLI 帮助
  和一组兼容性测试。托管 Runner 的临时目录归属不满足严格私有 ACL 夹具，因此相关合同仍需在
  当前用户拥有临时目录的 Windows 环境验证。

实现入口见 [`runtime/README.md`](../runtime/README.md)、
[`scripts/README.md`](../scripts/README.md)和
[`src/codex-client/README.md`](../src/codex-client/README.md)。本文不复制文件清单或历史逐轮记录。

## 固定设计

- 不开放无认证 TCP App Server，不以实验 WebSocket 代替当前固定 Transport。
- 不为每个 Surface 启动独立 stdio App Server；Windows 与 Unix 必须保留共享 Thread、Provider
  隔离和 `codexc remote` 的同一架构。
- 不为兼容 Windows 放宽 Unix Socket、凭据、审批、Workspace、进程或服务安全检查。
- Windows 系统代理不从 WinINET/WinHTTP 自动发现；只使用 Codex `.env` 明确配置或受支持的标准代理
  环境变量。
- 安装、更新和卸载只处理受管程序与服务；配置、数据库、凭据、日志和输出默认保留。

## 当前验证范围

CI 的 Windows Job覆盖：

```text
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix webui
npm run build
npm run check
npm run docs:check
PowerShell 脚本语法
codexc 与 service 帮助冒烟
Desktop 包检查与启动、回环桥网络行为、Windows Proxy 超时清理合同
选定的 Transport、服务、可执行文件兼容性测试
```

这些检查证明当前提交可在托管 Windows Runner 构建并通过选定合同，不等于完整测试、安装、服务
恢复或真实渠道验收已经通过。

## 正式支持门槛

以下项目全部完成后，才能移除 `Preview` 标识并在发行说明中声明 Windows 正式支持：

1. Windows 生产与测试 Lint、完整可运行测试、构建和 npm tarball 安装冒烟进入必过门禁；平台
   专属跳过必须有对应 Windows 合同，不能用整套跳过制造绿色结果。
2. 安装项目锁定版本 Codex CLI，运行真实 App Server 初始化、共享 Thread、Provider 隔离、
   Remote TUI、审批、中断、消息上限与关闭清理合同。
3. 使用两个普通 Windows 用户验证 IPC、配置、数据库、凭据、媒体和备份的跨用户读取与替换拒绝；
   提权终端不得改变受管文件或服务的用户归属。
4. 在干净普通用户环境验证源码安装、更新、失败恢复、计划任务启停、异常重启、系统重启、日志、
   Doctor、安全修复和卸载，确认没有明文凭据、错误 PATH 或失去管理的进程。
5. 对 Telegram、飞书、微信以及 OpenAI、DeepSeek、OpenCode Go 和自定义 Provider 完成发布候选
   主路径验收；真实凭据和账号只在操作者环境使用，不进入文档或日志。
6. 同步 README、使用指导、源码安装、发布说明、模块索引和 Doctor 文案，并保留仍未支持能力的
   明确边界。

## 失败与回滚

- Windows 专属实现失败时应停止对应入口并保留用户数据，不得回退到更宽松的 IPC 或凭据方案。
- 新的持久化格式必须走项目既有版本与升级流程；Windows 支持本身不构成新增 Schema 的理由。
- 安装或更新失败必须保留可执行的恢复说明；不能以删除配置、数据库或凭据作为自动恢复手段。
- 固定版本上游无法提供可共享且有安全边界的 Transport，或实现要求复制 App Server 状态机时，
  停止扩大实现并重新审查设计。
