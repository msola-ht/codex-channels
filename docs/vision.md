# 图片识别代理

Gateway 保留 Codex App Server 原生图片输入；只有当前模型目录不支持 `image` 时，才按显式配置
把已经由 Surface 校验的 PNG/JPEG 交给视觉识别适配器，并将受控文字结果提交到原 Thread。

当前模型原生支持图片时不会经过代理。当前模型不支持图片时，Gateway 把用户原始提示和最多四张
图片直接交给外部视觉模型，再将严格裁剪的识别结果送回原 Thread 完成回答。该流程不创建额外的
Codex Thread，也不区分双 Provider 或仅 DeepSeek 模式。外部请求发起后，渠道会明确提示图片
数量和本条要求已经发送到视觉 API；原生图片输入不会显示这条提示。

## 配置

运行 `codexc setup`，选择“模型渠道 → 图片识别 → 外部视觉 API”，再填写 Responses 兼容接口、
视觉模型 ID 和该接口自己的 API Key。两种 DeepSeek 安装模式使用相同配置。

```toml
[vision]
mode = "responses_api"
endpoint = "https://vision.example/v1/responses"
model = "视觉模型"
```

`endpoint` 必须是 HTTPS，只有本机回环地址允许 HTTP。接口必须接受 Responses 风格的
`input_image` Data URL 和严格 JSON Schema 输出。通过 `codexc setup` 填写的 API Key 单独保存到
`credentials/vision/` 私有凭据文件，不写入 Gateway 配置、数据库或日志。修改视觉配置后需要
重启 Gateway，不需要重启 App Server。

## 安全与失败边界

- 三渠道继续沿用最多四张、单张 10 MiB、整批 20 MiB、PNG/JPEG 签名和私有临时文件限制。
- 图片、API Key、上游响应正文和识别结果不写入 SQLite 或结构化日志。
- 外部 API Key 的目录和文件分别限制为 `0700`、`0600`，符号链接、错误所有者或开放权限失败关闭；
  禁用识图时删除不再使用的外部 Key。
- 图片中的文字和指令始终标为不可信资料，不能升级为系统或开发者指令。
- 识别结果明确标记为已经完成的视觉观察，原 Thread 不应搜索工作区或无条件要求用户重新上传；
  只有识别结果中的不确定项确实影响结论时才请求补图。
- 原始用户提示直接交给视觉模型，不由另一个模型规划、替代或改写。
- 外部响应最大 1 MiB，识别等待有明确超时；错误不会把上游正文发送给渠道。
- `mode = "disabled"` 是默认值；此时不支持图片的模型继续在创建 Turn 前明确拒绝。
