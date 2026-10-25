# 渠道图片发送

模型或本机把本地图片发回 Thread 绑定渠道会话的固定方式：`codexc channel send-image` 把图片
交给 Gateway，由 Gateway 使用对应渠道的机器人凭据发送，不依赖 lark-cli 等外部 CLI，也
不存在用户 OAuth 权限不一致的问题。

## 命令

```bash
codexc channel send-image /absolute/path/to/project/output/playwright/screenshot.png                 # 只有一个会话绑定时自动选择目标
codexc channel send-image /absolute/path/to/project/output/playwright/screenshot.png --thread <Thread ID>  # 明确指定目标会话
codexc channel send-image /absolute/path/to/image.png --thread <Thread ID> --format markdown  # QQ Markdown 图片
```

- 图片必须是绝对路径、非符号链接的普通文件、PNG/JPEG，大小 1 字节到 10 MiB。
- QQ 上传进一步限制为 5,000,000 字节；超过时在渠道发送前拒绝并沿失败归档处理。生成图片自动回传还受共享 Journal 单条 4 MiB（含 Base64 和元数据）的更小有效预算限制。QQ 图片源码已接线，尚未部署及客户端验收。
- QQ 显式图片在等队列、读取、上传及最终消息请求时复核原 Thread 绑定；先上传取得文件引用，再发富媒体消息，只有最终消息 ID 才确认送达。后台 Thread 正常释放后不能借前台仍存在的会话继续发送。已经发出的请求不能撤回。新的两阶段上传路径尚未部署或客户端验收。
- 飞书显式图片同步透传原 Thread 守卫及领取器停止信号，覆盖排队、读取前后、上传及 SDK 鉴权等待后的业务 HTTP；上传后解绑不继续创建图片消息。该守卫修复尚未部署或真实验收，本地读取本身不保证即时取消。
- 目标包含前台及仍保留的后台 Thread 绑定。`--thread` 只能指定一次；不指定时只有唯一绑定才会自动选择，存在多个绑定或没有绑定时拒绝。
- 提交前校验 Gateway 配置及当前状态库 Schema 和必需表结构；不兼容时拒绝入队，不修改数据库。
- 提交后命令立即返回，图片由网关轮询发送，不代表已送达客户端。
- `--format image|markdown` 默认 image；markdown 仅支持 QQ，沿相同图片校验、绑定、队列和归档发送。普通图片及生成图片默认不改成素材。
- QQ Markdown 模式使用素材 prepare、签名 PUT、complete，取得 `qqbot-media://image/v1/...` 后发单图 Markdown。平台最多保存 100 张，连续 90 天未引用会过期；本地只保留同一客户端生命周期内至多 100 个已完成且未过期的引用，不持久化、不跨重启去重、不延长平台返回 TTL，不自动删除平台素材。上传成功不代表消息已发送，只有最终消息 ID 才确认。
- Markdown 素材路径沿 120 秒发送预算和原 Thread 守卫；签名 PUT 使用匹配的 MIME 并核对 ETag/MD5。额度耗尽、过期、取消或未知结果明确失败，不自动改普通图片或重发。本地仍仅 PNG/JPEG、最多 5,000,000 字节，未扩大到平台全部格式。本轮尚未部署或真实 QQ 验收。

## 工作原理

1. 命令先通过共享校验读取有界图片字节，再私有原子写入状态数据库所在目录的 `channel-outbox/pending/`（默认 `~/.codex-connect/data/channel-outbox/pending/`），
   最后发布同名 manifest（`version`、`threadId`、`imagePath`、`createdAtMs`）；普通图片 version 1，Markdown 图片 version 2 且 `format: "markdown"`。入队失败清除本次暂存文件。
2. Gateway 默认每 3 秒扫描一次 `pending/`，通过 `threadId` 在会话路由中解析出
   `surface + accountId + conversationId`，再调用对应 Surface Outbox 的
   `sendChannelImage`，使用渠道机器人凭据发送。发送前先在同一目录将 `<编号>.json` 原子改名为
   `<编号>.sending` 领取请求，不改 manifest 内容；领取失败不会发送。
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
  `generated-image.ts` 的校验（绝对路径、无符号链接、普通文件、10 MiB、PNG/JPEG 签名）。
- 发送目标只能是已经绑定的会话；Thread 未绑定或绑定不存在时归档失败，不会猜测渠道。
- 目标在 Gateway 消费时解析并固定，等待渠道队列时不改投新的绑定。Telegram 在队列与实际发送边界
  复核该目标已登记 Actor 的当前授权；热撤权取消尚未执行的旧操作，重新授权后需重新提交。
  已经进入平台请求的图片可能已送出，取消不能撤回，也不会自动重发。
- 微信要求该会话已经建立回复上下文（先和机器人交互过），否则发送失败并归档。
- 网关重启期间提交且尚未领取的 `.json` 图片请求会在下次启动后继续发送；`done/`、`failed/` 不会自动清理，
  需要时手工删除。

## 恢复与回退

恢复操作前先停止 Gateway，完整备份 `channel-outbox/` 并保留原目录、文件权限。
本机制不修改 StateStore 或 version 1 manifest 字段，不迁移或删除现有图片。新增 Markdown 请求使用 version 2；不识别该版本的旧网关拒绝发送。回退前备份并将未处理的 version 2 manifest 及同编号图片移至 spool 外的私有隔离目录，升级后再人工核对处理；不把 version 2 改成 version 1。
无法归档时保留原文件和领取记录并记录日志；修复目录权限或磁盘问题后，网关只重试归档。
`.sending` 表示可能已经发送，不能改回 `.json` 自动重试；先在原渠道核对，再按需要重新提交。

回退到不识别 `.sending` 的版本前，停止 Gateway、备份整个 spool，并将全部 `.sending` 及其同编号
图片移到 spool 外的私有隔离目录，留待人工核对；尚未领取的 `.json` 可继续由旧版处理。
这些领取记录只保证普通进程重启后不自动重发，不提供断电后的磁盘持久性或平台恰好一次送达保证。
