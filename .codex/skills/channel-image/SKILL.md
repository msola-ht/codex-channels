---
name: channel-image
description: 使用 codexc channel send-image，把用户要求发送的本地图片或截图发回当前绑定的飞书、微信或 Telegram 会话。
---

# 渠道图片发送

## 发送步骤

1. 确认图片：绝对路径、普通文件、PNG/JPEG、不超过 10 MiB。
2. 确定目标 Thread：优先使用当前会话状态中的 Thread ID；本地只有一个会话绑定时可省略 `--thread`。
3. 运行命令：

```bash
codexc channel send-image /绝对/路径.png [--thread <Thread ID>]
```

4. 验证本次提交项：在 `~/.codex-connect/data/channel-outbox/` 下检查对应文件；`done/` 出现本项文件表示成功，`failed/` 出现本项 `*.error.txt` 表示失败。不要等待整个共享 `pending/` 清空。采用有界等待；超时报告尚未确认送达，不盲目重新发送或宣称成功。

## 禁止

- 不要使用 lark-cli、其他外部机器人 CLI 或手动调用平台 API 发送图片。
- 不要直接修改 `channel-outbox/` 目录内容；提交和归档都由命令与 Gateway 管理。

## 失败排查

- 读取 `failed/` 下对应的 `.error.txt`。
- 查看网关日志：`codexc service logs gateway`。
- 常见原因：多个会话绑定未指定 `--thread`；微信会话缺少回复上下文；图片格式或大小不合法；Gateway 未运行。
