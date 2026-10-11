# launchd 服务模板

本目录保存 macOS 用户级 launchd 模板，用于把 Codex App Server、多 Surface Gateway 与 WebUI
以及可选 Model Relay 安装为独立进程。

## 文件

- `com.hegenai.codex-app-server.plist.template`：启动共享 Codex App Server，并监听私有 Unix Socket。
- `com.hegenai.codex-gateway.plist.template`：启动连接该 Socket 的 Gateway。
- `com.hegenai.codex-webui.plist.template`：启动指标与低风险设置 WebUI，读取 `[webui]` 配置。
- `com.hegenai.codex-model-relay.plist.template`：独立模型 API 进程，使用内部 `service-model-relay` 入口。

模板中的占位符由 `codexc install` 调用的服务安装管理接口写入实际路径和运行环境。服务都通过 CLI
服务入口启动，并在每次启动时按 Codex Home 的 `.env`、标准环境变量和 macOS 系统代理的顺序解析代理，不把
自动发现的地址固化到 plist。安装流程加载 App Server 与 Gateway 服务，WebUI plist 只生成不
自动加载；Gateway plist 显式标记为受监管进程，配置要求重启时由 launchd 自动拉起；若检测到
不支持的其他标签仍在运行则明确拒绝，避免多个 Gateway 同时轮询。Gateway 启动前会等待受监管的
App Server 与全部私有 WebSocket 就绪，避免登录或开机并发加载时抢跑。卸载时保留用户配置和运行数据。
不要在模板中写入 Token、用户目录或机器相关绝对路径。Gateway 的停止和重启
不得终止共享 App Server。

日常管理使用 `codexc start/stop/restart/status/logs`。目标为 `gateway`、`appserver`、
`webui`、`relay` 或 `all`；WebUI 安装时只生成 plist 不自动启动，启动 `all` 时排除配置中关闭的 WebUI
（`[webui] enabled`），停止、状态与日志仍包含已安装的 WebUI。
不写目标时，启停、重启和状态默认 `all`，日志默认 `gateway`。

四份 plist 的 `ExitTimeOut` 都从共享停止预算渲染为 50 秒，给内部 30 秒清理及子服务
35 秒退出等待留出余量；停止控制器在 `bootout` 后也最多等待 50 秒确认 Job 卸载。
不依赖 macOS 版本各自的默认退出期限。升级源码或全局命令不会重写已安装 plist，
仅重启也不会加载新模板；需要在本机运行 `codexc install` 重新生成定义并卸载、加载核心 Job。
该操作会重启核心服务，并只启动已启用的 Relay；WebUI 运行状态保留。
已加载的 WebUI 需随后执行 `codexc restart webui` 才会加载新 plist，首次卸载仍沿用旧 Job 的期限。

验证安装管理接口已渲染的 plist（模板的整数占位符尚不能直接用于 plist 校验）：

```bash
plutil -lint "$HOME/Library/LaunchAgents/"com.hegenai.codex-*.plist
```

Relay 默认禁用；`all` 启动仅纳入已安装且启用的 Relay，停止先关闭 Relay，再关闭 Gateway。
状态包含已安装 Relay；单独停止 Gateway 不主动结束 Relay，指标接收不可用时由 Relay 记录未确认。
