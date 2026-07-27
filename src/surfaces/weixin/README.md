# 微信 Surface

当前实现阶段 0/Setup 的独立安全凭据边界，以及运行时接入前的窄协议 Client 和私有游标
检查点；尚未注册微信消息 Surface，未调用 Application 或修改 SQLite。

- `credential-store.ts`：严格校验版本 1 微信 Bot 凭据；macOS 使用独立 Keychain Service，
  Linux 使用独立 `credentials/weixin` AES-256-GCM 私有目录。
- `updates-cursor-store.ts`：在 `data/weixin-updates` 下按账号 SHA-256 文件名保存严格版本 1
  `get_updates_buf`；目录 `0700`、文件 `0600`，临时文件原子替换，损坏、未知版本和符号链接
  失败关闭。
- `protocol-client.ts`：实现固定 `v2.4.6` 的 `getupdates` 和 `sendmessage` HTTP 合同，
  在 JSON 数字转换前保留原始 `message_id`，只输出文本或带原因的忽略事件，并限制出站文本为
  已验证的 4000 个 UTF-16 码元。
- `updates-monitor.ts`：组合协议 Client 与游标 Store，顺序处理单批消息、按原始消息 ID
  进程内去重，仅在整批处理成功后提交游标，并对网络、限流及服务端瞬时失败执行有限重试。
- `index.ts`：微信模块公开入口。

二维码、验证码、扫码者 ID、消息和回复上下文均不持久化；长轮询游标只进入独立检查点，不进入
凭据、TOML 或 SQLite。未知版本、身份不匹配、密文或载荷损坏失败关闭，不能当作未配置后静默
重新扫码。监控器不自行启动后台任务，尚未注册为微信消息 Surface，也未把消息交给 Application。
