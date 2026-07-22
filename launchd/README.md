# launchd 服务模板

本目录保存 macOS 用户级 launchd 模板，用于把 Codex App Server 与 Telegram Gateway 安装为两个独立进程。

## 文件

- `com.hegenai.codex-app-server.plist.template`：启动共享 Codex App Server，并监听私有 Unix Socket。
- `com.hegenai.codex-gateway.plist.template`：启动连接该 Socket 的 Gateway。

模板中的占位符由 `scripts/install-launchd.mjs` 写入实际路径、代理和运行环境。安装流程会停止并删除旧版 `com.msola.*` Job 和 plist，再加载 `com.hegenai.*` 服务，用户配置与运行数据不迁移也不删除。不要在模板中写入 Token、用户目录或机器相关绝对路径。Gateway 的停止和重启不得终止共享 App Server。

验证模板：

```bash
plutil -lint launchd/*.plist.template
```
