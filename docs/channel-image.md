# 渠道图片发送

模型或本机把本地图片发回 Thread 绑定渠道会话的固定方式：`codexc channel send-image` 把图片
交给 Gateway，由 Gateway 使用对应渠道的机器人凭据发送，不依赖 lark-cli 等外部 CLI，也
不存在用户 OAuth 权限不一致的问题。

## 命令

```bash
codexc channel send-image /absolute/path/to/project/output/playwright/screenshot.png                 # 只有一个会话绑定时自动选择目标
codexc channel send-image /absolute/path/to/project/output/playwright/screenshot.png --thread <Thread ID>  # 明确指定目标会话
```

- 图片必须是绝对路径、非符号链接的普通文件、PNG/JPEG，大小 1 字节到 10 MiB。
- 目标包含前台及仍保留的后台 Thread 绑定。`--thread` 只能指定一次；不指定时只有唯一绑定才会自动选择，存在多个绑定或没有绑定时拒绝。
- 提交前校验 Gateway 配置及当前状态库 Schema 和必需表结构；不兼容时拒绝入队，不修改数据库。
- 提交后命令立即返回，图片由网关轮询发送，不代表已送达客户端。

## 工作原理

1. 命令先通过共享校验读取有界图片字节，再私有原子写入状态数据库所在目录的 `channel-outbox/pending/`（默认 `~/.codex-connect/data/channel-outbox/pending/`），
   最后发布同名 manifest（`version`、`threadId`、`imagePath`、`createdAtMs`）；入队失败清除本次暂存文件。
2. Gateway 默认每 3 秒扫描一次 `pending/`，通过 `threadId` 在会话路由中解析出
   `surface + accountId + conversationId`，再调用对应 Surface Outbox 的
   `sendChannelImage`，使用渠道机器人凭据发送。
3. 成功：manifest 和图片一起归档到 `done/`。
4. 失败：manifest、图片和 `*.error.txt`（原因）一起归档到 `failed/`，并在网关日志
   记录；失败项不会反复重试。

## 安全与边界

- `channel-outbox/` 及其子目录权限为 `0700`，manifest 和复制的图片为 `0600`。
- 提交端和 Gateway 启动端在收紧目录权限前拒绝符号链接或错误所有者，已有目录也须通过检查。
- Gateway 只接受位于 `pending/` 目录内的图片路径；读取时复用
  `generated-image.ts` 的校验（绝对路径、无符号链接、普通文件、10 MiB、PNG/JPEG 签名）。
- 发送目标只能是已经绑定的会话；Thread 未绑定或绑定不存在时归档失败，不会猜测渠道。
- 微信要求该会话已经建立回复上下文（先和机器人交互过），否则发送失败并归档。
- 网关重启期间提交的图片会在下次启动后继续发送；`done/`、`failed/` 不会自动清理，
  需要时手工删除。
