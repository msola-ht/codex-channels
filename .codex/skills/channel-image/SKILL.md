---
name: channel-image
description: 把本地图片或截图发送回当前飞书、微信或 Telegram 会话时使用。触发场景包括用户要求“把截图发过来/发我看看”、需要把页面截图、生成的图表或本地图片发给当前渠道。使用 codexc channel send-image，禁止使用 lark-cli 或其他外部渠道 CLI 发图。
---

# 渠道图片发送

## 发送步骤

1. 确认图片：绝对路径、普通文件、PNG/JPEG、不超过 10 MiB。
2. 确定目标 Thread：优先使用当前会话状态中的 Thread ID；本地只有一个会话绑定时可省略 `--thread`。
3. 运行命令：

```bash
codexc channel send-image /绝对/路径.png [--thread <Thread ID>]
```

4. 验证结果：`~/.codex-connect/data/channel-outbox/` 下 `pending/` 清空且 `done/` 出现同名文件即发送成功；`failed/` 出现 `*.error.txt` 则发送失败，读取原因。

## 禁止

- 不要使用 lark-cli、其他外部机器人 CLI 或手动调用平台 API 发送图片。
- 不要直接修改 `channel-outbox/` 目录内容；提交和归档都由命令与 Gateway 管理。

## 失败排查

- 读取 `failed/` 下对应的 `.error.txt`。
- 查看网关日志：`codexc service logs gateway`。
- 常见原因：多个会话绑定未指定 `--thread`；微信会话缺少回复上下文；图片格式或大小不合法；Gateway 未运行。
