# 渠道图片发送

模型或本机把本地图片发回 Thread 绑定渠道会话的固定方式：`codexc channel send-image` 把图片
交给 Gateway，由 Gateway 使用对应渠道的机器人凭据发送，不依赖 lark-cli 等外部 CLI，也
不存在用户 OAuth 权限不一致的问题。

## 命令

```bash
codexc channel send-image /absolute/path/to/project/output/playwright/screenshot.png                 # 只有一个会话绑定时自动选择目标
codexc channel send-image /absolute/path/to/project/output/playwright/screenshot.png --thread <Thread ID>  # 明确指定目标会话
codexc channel send-image /absolute/path/to/project/output/playwright/screenshot.png --thread <Thread ID> --turn <Turn ID>  # QQ 须指定原 Turn
```

- 图片必须是绝对路径、非符号链接的普通文件、PNG/JPEG，大小 1 字节到 10 MiB。
- QQ 上限为 3 MiB，必须显式指定 `--turn`，该参数仅用于 QQ；只接受当前 Gateway 运行代次内已确认关联的原 Turn，
  或官方同 Thread 根工作链已确认关联的后续 Turn。原 Actor、目标、绑定、当前授权和五分钟、四次回复预算均须有效。
  CLI 没有权威 Turn 环境变量，不从最新轮次、最新来信或工具调用编号推断；不掌握原 Turn ID 时不能提交 QQ 图片。
- 目标包含前台及仍保留的后台 Thread 绑定。`--thread` 只能指定一次；不指定时只有唯一绑定才会自动选择，存在多个绑定或没有绑定时拒绝。
- 提交前校验 Gateway 配置及当前状态库 Schema 和必需表结构；不兼容时拒绝入队，不修改数据库。
- 提交后命令立即返回，图片由网关轮询发送，不代表已送达客户端。

## 工作原理

1. 命令先通过共享校验读取有界图片字节，再私有原子写入状态数据库所在目录的 `channel-outbox/pending/`（默认 `~/.codex-connect/data/channel-outbox/pending/`），
   最后发布同名 manifest：非 QQ 使用 version 1（`version`、`threadId`、`imagePath`、`createdAtMs`），
   QQ 使用 version 2，额外固定 `turnId` 和 `target`（`surface`、`accountId`、`conversationId`）；入队失败清除本次暂存文件。
2. Gateway 默认每 3 秒扫描一次 `pending/`，通过 `threadId` 在会话路由中解析出
   `surface + accountId + conversationId`，再调用对应 Surface Outbox 的
   `sendChannelImage`，使用渠道机器人凭据发送。发送前先在同一目录将 `<编号>.json` 原子改名为
   `<编号>.sending` 领取请求，不修改 manifest 版本或内容；领取失败不会发送。
   version 2 在消费时及 QQ 排队、读取和每次实际平台请求前复核原绑定与身份，拒绝改投；version 1 不能发往 QQ。
3. 成功：manifest 和图片一起归档到 `done/`。
4. 失败：manifest、图片和 `*.error.txt`（原因）一起归档到 `failed/`，并在网关日志
   记录；失败项不会反复重试发送。归档失败时保留 `.sending`，后续轮询只重试归档。
   重启后遗留的 `.sending` 按发送结果未知归档失败，即使发送已完成，也不会自动重新发送；
   领取后、发送前退出同样可能尚未发送，需要人工核对。

## 安全与边界

- `channel-outbox/` 及其子目录权限为 `0700`，manifest 和复制的图片为 `0600`。
- 提交端和 Gateway 启动端在收紧目录权限前拒绝符号链接或错误所有者，已有目录也须通过检查。
- Gateway 只接受位于 `pending/` 目录内、与 manifest 同编号的 `.png` 或 `.jpg` 图片路径；消费与归档时
  复核文件类型、所有者和私有权限，读取时复用
  `generated-image.ts` 的校验（绝对路径、无符号链接、普通文件、默认 10 MiB／QQ 3 MiB、PNG/JPEG 签名）。
- 发送目标只能是已经绑定的会话；Thread 未绑定或绑定不存在时归档失败，不会猜测渠道。
- 目标在 Gateway 消费时解析并固定，等待渠道队列时不改投新的绑定。Telegram 在队列与实际发送边界
  复核该目标已登记 Actor 的当前授权；热撤权取消尚未执行的旧操作，重新授权后需重新提交。
  已经进入平台请求的图片可能已送出，取消不能撤回，也不会自动重发。
- 微信要求该会话已经建立回复上下文（先和机器人交互过），否则发送失败并归档。
- QQ 先复用生成图片的安全读取和普通图片上传，再发送消息；上传成功不代表送达。图片消费一次原来信额度，
  与正文、交互和完成信息共用预算，失败或结果未知不退还、不自动重试，也不借新来信补发。
- 正文 Markdown 的图片路径或 URL 继续作为可读文字，不自动读取或下载。飞书/TG 也没有将任意正文链接升级为可信图片资产的共享合同；
  生成图片事件与显式命令使用上述独立资产入口，QQ Markdown 素材不复用普通图片上传凭据。
- 网关重启期间提交且尚未领取的 `.json` 图片请求会在下次启动后继续处理；QQ 原 Grant 在重启后失效，归档失败而不发送；`done/`、`failed/` 不会自动清理，
  需要时手工删除。

## 恢复与回退

QQ 图片适配采用显式双版本：既有 version 1 保持原字段与处理规则，新增 version 2
固定提交时的目标（`surface + accountId + conversationId`）和显式 `turnId`；QQ 只接受
version 2，并复核原 Actor、Thread、Turn、目标和当前授权。不会从最新来信或最新 Turn 补全身份。
本次实现不读取或搬迁用户现有 spool，不迁移、覆盖或删除既有 version 1 项，不修改 StateStore
或 QQ 传输登记格式。新请求的失败项继续保留；已领取项的发送结果未知时绝不自动重发。

运维变更前先停止 Gateway 并停止图片提交，完整备份 `channel-outbox/`（含 pending、done、failed
及隐藏暂存文件），保留目录和文件的私有权限。无法归档时保留原文件和 `.sending`，修复后只重试归档。
回滚到只支持 version 1 的程序前，必须在停写状态下把全部 version 2 manifest（含 `.json`、
`.sending`）及其同编号图片移至 spool 外的私有隔离目录，保留核对记录，不得让旧版消费 version 2。
version 1 可以留给旧版继续处理；version 2 须核对原渠道后另行显式提交，不能改版本或恢复为待发送项。

`.sending` 表示可能已经发送，不能改回 `.json` 自动重试；先在原渠道核对，再按需要重新提交。

回退到不识别 `.sending` 的版本前，停止 Gateway、备份整个 spool，并将全部 `.sending` 及其同编号
图片移到 spool 外的私有隔离目录，留待人工核对；尚未领取的 version 1 `.json` 可继续由旧版处理。
这些领取记录只保证普通进程重启后不自动重发，不提供断电后的磁盘持久性或平台恰好一次送达保证。
