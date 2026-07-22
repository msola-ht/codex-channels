# Codex Telegram Bridge

一个本地常驻的 Python 服务，在 Telegram Bot 与 Codex App Server 之间转发消息。

## 当前能力

- Telegram 用户白名单
- `.env` 配置读取与启动时校验
- Telegram Long Polling，无需公网 Webhook
- Codex App Server stdio/JSONL 通讯
- Telegram 会话与 Codex Thread 的 SQLite 持久化映射
- 按 Telegram `chat_id` 保存、命名和切换 Codex 历史 Thread
- Codex 流式回复；按 App Server Item 分隔阶段消息，Telegram 网络延迟时在后台缓冲
- 任务结束后主动推送最终结果
- 受限命令、额外写入和临时权限通过 Telegram 按钮审批
- 本地 `codex-tg` CLI 与 Telegram 共用同一个 Codex Thread
- CLI 与 Telegram 双向镜像任务输入、流式输出、完成状态和审批
- Telegram 等效 Codex 命令、会话管理和 `/whoami`
- 同一会话运行期间的新消息通过 `turn/steer` 追加

服务使用 `approvalPolicy=on-request`。Codex 在沙箱内直接工作；需要越过当前权限边界时，Bot 会发送“批准一次 / 拒绝”按钮。审批超时或无法关联到原 Telegram 会话时自动拒绝。

## 安装

要求 Python 3.11+，并确保 `codex` 命令已经登录且可用。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cp .env.example .env
```

编辑 `.env`：

```dotenv
TELEGRAM_BOT_TOKEN=从_BotFather_取得的_Token
TELEGRAM_ALLOWED_USER_IDS=你的_Telegram_用户_ID
CODEX_WORKDIR=/要交给_Codex_操作的绝对目录
APPROVAL_TIMEOUT_SECONDS=300
LOCAL_CLI_CHAT_ID=你的_Telegram_私聊_ID
LOCAL_SOCKET_PATH=./data/bridge.sock
```

如果不知道 Telegram 用户 ID，可以先从可信的 ID 查询方式获取；服务启动后，Bot 的 `/whoami` 也只会返回消息发送者自己的 ID。

## 运行

```bash
codex-tg-bridge
```

也可以直接运行模块：

```bash
python -m codex_tg_bridge.main
```

保持 Bridge 运行，再打开另一个终端：

```bash
codex-tg
```

只有 `codex-tg-bridge` 是常驻服务。它在后台运行本机 `codex app-server --stdio`，因此实际执行任务的仍是已登录的 Codex；Telegram 和 `codex-tg` 都只是交互界面。

`codex-tg` 是可选的终端客户端，通过权限为 `0600` 的 Unix Socket 连接 Bridge，不会另启 Codex 进程。只使用 Telegram 时无需启动它。直接输入任务即可与 Telegram 共用 Thread；输入 `/help` 查看本地命令，`/quit` 退出终端但不停止 Bridge。

CLI 输入会以“本地 CLI 指令”同步到 Telegram；Telegram 的普通任务消息会显示在 CLI。Codex 的流式回复和结束状态同时发往两个界面。审批会同时出现在已连接的 CLI 和 Telegram，先处理的一端生效，另一端随即失效。

共享会话以 `LOCAL_CLI_CHAT_ID` 对应的 Telegram `chat_id` 为边界。TG 和 `codex-tg` 对同一 `chat_id` 操作同一个“当前 Thread”；任一端执行 `/switch`、`/last`、`/new` 或 `/session_name` 后，另一端下一条任务也会使用更新后的会话。任务运行期间不允许切换，需等待完成或先 `/stop`。

## Bot 命令

- `/start`：显示使用说明
- `/whoami`：返回当前 Telegram 用户 ID
- `/new`：中断并退出当前 Thread；保留历史，下一条消息创建新 Thread
- `/sessions`：列出当前 Telegram 会话可恢复的历史 Thread
- `/switch <序号|名称|Thread ID>`：切换历史 Thread
- `/last`：切换到上一个使用的 Thread
- `/session_name <名称>`：命名当前 Thread
- `/status`：显示 Thread、Turn、模型、安全模式和工作目录
- `/stop`：中断当前 Codex Turn
- `/model`：列出模型；`/model <模型ID>` 为当前 Telegram 会话切换模型
- `/compact`：压缩当前 Thread 上下文
- `/fork`：分叉当前 Thread，并切换到新 Thread
- `/review`：审查未提交改动；也支持 `branch`、`commit`、`custom` 参数
- `/skills`：列出当前工作目录可用的 Skills
- `/mcp`：列出 MCP Server、鉴权状态和工具数量
- `/plugins`：列出已发现的 Plugins
- `/usage`：显示当前账号的用量摘要
- `/permissions`：显示安全模式；可切换 `read-only` 或 `workspace-write`
- `/goal`：查看 Goal；使用 `/goal set <目标>` 设置，`/goal clear` 清除
- `/help`：显示 Telegram 支持的命令

模型、安全模式和历史 Thread 都按 Telegram `chat_id` 持久化。`/new` 只退出当前 Thread，不删除历史记录；下一条普通文本会创建新 Thread，旧 Thread 可通过 `/sessions` 和 `/switch` 恢复。旧版本数据库会在 Bridge 启动时自动把当前映射迁移到历史记录。普通文本就是 Codex 任务指令；任务运行期间继续发文本会通过 `turn/steer` 追加要求，完成后结果会主动返回 Telegram。

审批只允许任务所属的白名单 Telegram 会话操作。按钮只批准当前一次请求，不支持整场会话或永久放行，也不会自动切换到 `danger-full-access`。默认 5 分钟超时自动拒绝，可通过 `APPROVAL_TIMEOUT_SECONDS` 调整为 30–3600 秒。

Codex CLI 中的纯终端界面命令（例如 `/theme`、`/vim`、`/copy`、`/exit`）没有 Telegram 等价行为，Bot 会明确提示“不适用”，不会把它们误发给模型。

## 安全边界

- `.env` 已加入 `.gitignore`，不要把 Bot Token 写入代码或日志。
- 日志会脱敏 Bot Token，并关闭可能包含完整 Bot API URL 的 HTTP INFO 日志。
- `TELEGRAM_ALLOWED_USER_IDS` 必须非空，未授权用户只能使用 `/whoami`。
- `CODEX_WORKDIR` 必须是已存在的绝对目录。
- 本地 CLI 只连接 Unix Socket，Socket 权限固定为当前系统用户可读写。
- `LOCAL_CLI_CHAT_ID` 决定 CLI 共享哪个 Telegram 会话；只有一个白名单用户时可省略并自动使用该用户 ID。
- `CODEX_BRIDGE_SANDBOX` 只接受 `read-only` 或 `workspace-write`。
- 拒绝 `danger-full-access`，仅支持 `read-only` 与 `workspace-write`。
- 未映射会话、过期按钮、非白名单用户和服务停止期间的审批都会拒绝。
- App Server 仅通过子进程 stdio 使用，不监听公网端口。

## 测试

```bash
python -m unittest discover -s tests -v
```

只验证本机 App Server 初始化握手、不创建 Thread 或调用模型：

```bash
python scripts/smoke_app_server.py
```

使用 `.env` 中的配置执行一次真实模型调用和 Telegram Bot 鉴权：

```bash
python scripts/smoke_model.py
python scripts/smoke_telegram.py
python scripts/smoke_telegram.py --send-test
```

验证真实 App Server 会发出审批请求，并在拒绝后不落盘：

```bash
python scripts/smoke_approval.py
```
