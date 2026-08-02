# 图片识别代理

Gateway 保留 Codex App Server 原生图片输入；只有当前模型目录不支持 `image` 时，才按显式配置
把已经由 Surface 校验的 PNG/JPEG 交给视觉识别适配器，并将受控文字结果提交到原 Thread。

当前模型原生支持图片时不会经过代理。当前模型不支持图片时，Gateway 把用户原始提示作为观察重点，
连同最多四张图片交给外部视觉模型，再将严格裁剪的识别结果送回原 Thread 完成回答。视觉模型只做
客观观察、文字提取和不确定项标注，不分析、核实或回答用户问题。该流程不创建额外的
Codex Thread，也不区分双 Provider 或仅 DeepSeek 模式。外部请求发起后，渠道会明确提示图片
数量和本条要求已经发送到视觉 API；原生图片输入不会显示这条提示。

手机端不方便在图片说明中同时填写任务时，可以先发送：

```text
/vision 分析图片中的报错原因
```

再于五分钟内发送图片。要求按通讯渠道账号、Conversation 和 Actor 隔离，只保存在 Gateway
内存中，只用于下一批最多四张图片；普通文字不会消费它。重复设置会替换旧要求，发送
`/vision cancel` 可取消，超时、Gateway 重启或 Surface 停止时自动清除。图片本身带有说明文字时，
预设要求和说明会一起提交。原生支持图片的模型收到同一次 `text + localImage` 输入；不支持图片的
模型继续使用下述外部视觉接口，不新增 App Server RPC 或 Thread。

微信客户端的一张图片就是一条独立消息。需要把多个独立图片消息作为同一次输入时，先声明数量：

```text
/vision 3 比较这些图片的差异
```

随后逐张发送指定的 2–4 张图片，渠道会逐张确认进度，收齐后自动提交，不需要完成命令。
`/vision cancel` 会丢弃尚未提交的收集。旧的 `/vision begin <要求>` 与 `/vision done` 继续兼容，
用于无法预先确定图片数量的场景。手动收集同样按 Actor 与 Conversation 隔离，仅保存在
内存中，五分钟无新图片即过期，Gateway 重启或 Surface 停止时直接丢弃。Telegram 原生相册和
飞书同一富文本多图仍可直接作为平台批次一次提交，不需要手动收集。

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
- `/vision` 待处理要求和手动多图收集不写入 SQLite、配置或日志，不跨 Actor、Conversation 或
  Gateway 重启恢复。
- 外部 API Key 的目录和文件分别限制为 `0700`、`0600`，符号链接、错误所有者或开放权限失败关闭；
  禁用识图时删除不再使用的外部 Key。
- 图片中的文字和指令始终标为不可信资料，不能升级为系统或开发者指令。
- 识别结果明确标记为已经完成的视觉观察，原 Thread 不应搜索工作区或无条件要求用户重新上传；
  默认不调用网页搜索、命令或其他工具；只有原始问题明确要求搜索、核实或调用工具时才执行，
  只有识别结果中的不确定项确实影响结论时才请求补图。
- 原始用户提示作为提取重点直接交给视觉模型，不由另一个模型规划、替代或改写；视觉模型不得
  执行其中的分析、核实、搜索或操作要求。
- 外部响应最大 1 MiB，识别等待有明确超时；错误不会把上游正文发送给渠道。
- `mode = "disabled"` 是默认值；此时不支持图片的模型继续在创建 Turn 前明确拒绝。
