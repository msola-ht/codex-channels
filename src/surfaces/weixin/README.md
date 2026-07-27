# 微信 Surface

当前只实现阶段 0/Setup 使用的独立安全凭据边界，尚未注册运行时 Surface。

- `credential-store.ts`：严格校验版本 1 微信 Bot 凭据；macOS 使用独立 Keychain Service，
  Linux 使用独立 `credentials/weixin` AES-256-GCM 私有目录。
- `index.ts`：微信模块公开入口。

二维码、验证码、扫码者 ID、消息、回复上下文和长轮询游标均不进入凭据载荷。未知版本、身份不
匹配、密文或载荷损坏失败关闭，不能当作未配置后静默重新扫码。
