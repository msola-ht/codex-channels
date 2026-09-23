# Codex 0.156.1 图片文件引用探测记录

本记录保存原生图片引用需求的脱敏证据与复现步骤，不是 Gateway 功能入口或自动验收脚本。
用户最终明确的目标为避免后续请求重复携带 Base64；其中下载和生命周期研究不代表要求文件管理入口。
当前采用范围见[升级决策](codex-cli-upgrade-decisions.md#图片文件引用需求阻塞与实现边界)，
源码定位见[协议索引](index.md#固定版本官方源码)。

## 环境与结论

- 固定源码：`b412ff32c417f855c2b2d1581b77058eed87c84b`（`rust-v0.156.1`）。
- 离线：Linux，独立 `codex-cli 0.156.1`，隔离 Codex Home、Workspace 和本地模拟 Responses 后端。
- 在线：2026-09-23 UTC，当前 ChatGPT 账户；模型目录读取自仍运行的 `0.155.1` App Server。
  推理直接请求官方 HTTP 后端，未经过 Gateway，不能计为 `0.156.1` App Server 在线端到端验收。
- 已证实协议转发、历史与 Queue 恢复、当前账户上传和即时下载，以及后端未拒绝携带文件编号的请求。
- 首轮 64×32 图的两种输入均识别错误；后续获授权的 512×256 图两种输入均正确识别左红右蓝。
  这证明当前账户、当前模型对该上传编号的在线识图互通，不代表全部图片或账户的支持保证。
- 未验证仅凭编号重新取回、下载地址刷新、过期、跨账户拒绝和删除。

## 离线观测

以下为初始真实 App Server 探测；转发、分页历史、后续纯文本 Turn 复用和后端拒绝已纳入
[`real-app-server-supervised-tools.test.ts`](../tests/real-app-server-supervised-tools.test.ts)
的 `forwards image fileId` 合同，其余仍为一次性观测。模拟后端不读取图片。

| 检查 | 观测 |
| --- | --- |
| 普通 Turn 引用转发 | `image.fileId` 转为出站 `input_image.file_id`，保留 `detail: high` |
| 分页历史 | `thread/turns/list` 的完整 Item 保留原引用 |
| 活动 Turn 期间入队与列表 | Queue 保留原引用 |
| 中断、进程重启与恢复 | 历史和未消费 Queue 均保留引用 |
| 显式启动 Queue | 再次转发原引用 |
| 图片缺少 URL 和编号 | RPC 返回 `-32600` |
| 空字符串编号 | 未在 RPC 边界被拒绝，仍转发给后端；这是观测，不是符合预期的有效输入 |
| 模拟后端拒绝编号 | HTTP 400 `invalid_image` 后 Turn 失败，原始 App Server 错误包含测试响应正文 |

模拟后端共收到五次请求，均为 `POST /responses`。没有文件上传或解析请求。
首次模型夹具缺少 `experimental_supported_tools`，配置失败且未请求后端；补齐后，第一次 Queue
恢复检查又因空闲 Thread 自动派发而失去待检查条目。最终采用活动 Turn 入队、中断、重启顺序完成。
这些夹具问题不作为协议故障计入结论。

## 在线证据摘录

以下字段从原始结果按白名单提取；省略本机路径、真实文件编号、账户标识、凭据和签名地址。
报告中的响应状态是观测值，不保证其他账户或后续后端行为相同。

### 上传与即时下载

```json
{
  "startedAt": "2026-09-23T05:17:42.034Z",
  "stages": [
    {
      "stage": "create",
      "status": 200,
      "contentType": "application/json",
      "challenge": false
    },
    {
      "stage": "upload",
      "status": 201
    },
    {
      "stage": "finalize",
      "status": 200,
      "completion": "success"
    },
    {
      "stage": "download",
      "status": 200
    }
  ],
  "image": {
    "format": "png",
    "width": 64,
    "height": 32,
    "bytes": 113,
    "sha256": "fc75966897d50143d883d0f9cc09b6b508989a4a6dcb03650983dba508377741"
  },
  "bytesMatch": true,
  "downloadSha256": "fc75966897d50143d883d0f9cc09b6b508989a4a6dcb03650983dba508377741",
  "finishedAt": "2026-09-23T05:17:45.720Z"
}
```

### 文件编号输入

```json
{
  "model": "gpt-6-luna",
  "httpStatus": 200,
  "completed": true,
  "answer": "The image is solid blue from left to right.",
  "expectedOrder": false,
  "finishedAt": "2026-09-23T05:26:10.658Z"
}
```

### 同图 Data URL 对照

```json
{
  "inputKind": "inline",
  "model": "gpt-6-luna",
  "httpStatus": 200,
  "completed": true,
  "answer": "The image is uniformly bright blue from left to right.",
  "expectedOrder": false,
  "finishedAt": "2026-09-23T05:26:55.593Z"
}
```

两次使用相同模型、提示和图像字节，仅改变图片输入表示。正确结果应说明左侧红色、右侧蓝色。
两次回答均为全蓝，根因尚未确定；不能归因于 `fileId`，也不能据此宣布识图验收通过。

## 测试夹具与复现步骤

### 无敏感数据的原图

PNG：64×32，RGB，左半红色、右半蓝色，共 113 字节。下面是完整 Base64，可解码为原始夹具；
SHA-256 应与上传结果中的 `image.sha256` 一致。

```text
iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAOElEQVR4nO3PsQkAAAzDsPz/dHpFliLwbFCaTBvvu94DAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAQcOkv4asq/aw0AAAAASUVORK5CYII=
```

### 离线协议复现

1. 使用精确 `0.156.1` CLI 和隔离临时 Codex Home、Workspace。模型目录声明文本与图片能力，
   包含固定源码要求的 `experimental_supported_tools`；本地 Provider 指向回环模拟 Responses 服务，
   禁用请求与流重试。不得读取生产会话文件。
2. 启动 `codex app-server --stdio`，只初始化一次并发送 `initialized`。历史与 Queue 探测使用
   项目已允许的实验范围，其他 Server Request 明确拒绝。
3. 创建 Thread，提交测试编号 `file_offline_probe_123` 和 `detail: high`；模拟后端检查
   `input_image.file_id`，再返回合法的 `response.created`、输出 Item 与 `response.completed`。
4. 用 `thread/turns/list`、`itemsView: full` 检查引用。保持下一 Turn 的模拟流未完成，期间入队，
   然后中断该 Turn、停止隔离进程、使用相同临时 Home 重启并恢复 Thread；检查历史和 Queue 后显式启动。
5. 分别提交缺少引用与空字符串引用，记录 RPC 错误及是否请求后端。让模拟后端对无效编号返回
   400 `invalid_image`，断言 Turn 失败。关闭隔离进程和模拟服务。

### 在线复现

此流程会创建账户文件并消耗模型额度，须单独获得执行授权；本记录不授权自动重跑。

1. 使用当前有效的 ChatGPT 认证与固定源码 `codex-api/src/files.rs` 的流程：
   对官方 ChatGPT 基地址的 `/files` 发送 `file_name`、`file_size: 113`、`use_case: codex`。
   凭据仅保留在内存，不输出请求头或完整响应。
2. 将上述 PNG 字节 PUT 到返回的上传地址，按固定源码设置 Blob 上传头；不要把账户认证头
   发送到签名存储地址。对 `/files/{id}/uploaded` 确认，使用返回的签名下载地址 GET 文件，
   比较字节和 SHA-256。此步骤只验证上传后即时下载，不是独立按编号取回。
3. 通过已登录 App Server 的稳定 `model/list` 获取能力目录。本次选用声明图片输入的
   `gpt-6-luna`，思考等级为 `low`。初始化使用官方非全局身份 `codex_app_server_daemon`。
4. 直接向官方 `/backend-api/codex/responses` 发起流式请求，`store: false`、空工具列表，
   instructions 为 `Answer the visual question directly. Do not call tools.`；用户文本为
   `Describe the dominant colors in this image from left to right. Answer in one short sentence.`。
   图片内容先使用 `{ "type": "input_image", "file_id": "<本次上传编号>" }`，再以相同夹具
   的 `image_url` Data URL 作对照。两个请求均不在提示中透露预期颜色。
5. 分别检查完成事件与实际回答，不用 HTTP 成功代替识图断言；只保存脱敏结果。
   每次请求有超时和响应大小上限，不盲目重试上传或推理。

## 后续较大图片对照

用户重新授权后，于 2026-09-23 UTC 使用相同红蓝分区内容的 512×256 PNG，
保持模型、思考等级、提示与请求流程不变，新增一次上传、两次推理。
上传、确认与即时下载成功，下载字节与原图一致。两种输入均正确识别左红右蓝。
小图误识别的根因仍未确定；尺寸变化后成功不等于已证明某个尺寸阈值或上游图像处理缺陷。
本轮仍为直接 HTTP 探测，不计入 Gateway 或精确版本 App Server 在线端到端验收。

### 上传与下载

```json
{
  "startedAt": "2026-09-23T06:35:44.018Z",
  "stages": [
    {
      "stage": "create",
      "status": 200,
      "contentType": "application/json",
      "challenge": false
    },
    {
      "stage": "upload",
      "status": 201
    },
    {
      "stage": "finalize",
      "status": 200,
      "completion": "success"
    },
    {
      "stage": "download",
      "status": 200
    }
  ],
  "image": {
    "format": "png",
    "width": 512,
    "height": 256,
    "bytes": 1554,
    "sha256": "ec4054e294c1263d42be87a25babd045d172c25d94434cda0ed810722670d075"
  },
  "bytesMatch": true,
  "downloadSha256": "ec4054e294c1263d42be87a25babd045d172c25d94434cda0ed810722670d075",
  "finishedAt": "2026-09-23T06:35:46.751Z"
}
```

### Data URL

```json
{
  "inputKind": "inline",
  "model": "gpt-6-luna",
  "httpStatus": 200,
  "completed": true,
  "answer": "The image is bright red on the left and deep blue on the right.",
  "expectedOrder": true,
  "finishedAt": "2026-09-23T06:36:22.495Z"
}
```

### 文件编号

```json
{
  "inputKind": "fileId",
  "model": "gpt-6-luna",
  "httpStatus": 200,
  "completed": true,
  "answer": "The image is red on the left and blue on the right.",
  "expectedOrder": true,
  "finishedAt": "2026-09-23T06:37:28.204Z"
}
```

较大夹具为 512×256、8 位 RGB、无透明度的 PNG；每行前 256 像素为 `(255, 0, 0)`，
后 256 像素为 `(0, 0, 255)`。复现时按前述在线步骤替换图片字节和 `file_size`；
不同 PNG 编码器可能生成不同文件字节，本轮实际字节数及 SHA-256 以上述摘录为准。

## 取回与生命周期源码复核

核查范围为固定版 `codex-api/src/files.rs`、`core/src/mcp_openai_file.rs`、
`attachment-store/src/lib.rs` 与其测试，并搜索其余 Rust 源码中的文件下载、解析和删除调用。

- 上传确认循环只在后端返回 `retry` 时继续，并在 `success` 时返回下载地址；
  它没有定义成功后重新调用以刷新过期地址的合同，不能把确认请求当作刷新接口。
- `AttachmentStore::resolve` 抽象支持 `download_url_ttl`，但默认 `InlineAttachmentStore`
  解析编号始终返回 `NotFound`。抽象字段不能作为已可调用的取回服务。
- 本次核查未找到这类 Apps 文件的独立按编号取回、地址刷新或删除实现；
  Plugin 下载与 Thread 附件关联移除不构成该能力。此结论限定固定源码，不声称服务端绝无其他接口。
- 未猜测或请求未确认的后端地址，未删除账户文件。

## 未执行项及账户遗留

隔离 App Server 的 `chatgptAuthTokens` 登录尝试被实验限制拒绝，未创建认证文件，未进行该路径
的在线推理。固定源码将此字段标为内部专用，探测未为此启用实验接口。
扩大图片最初未获执行批准；用户随后授权继续，已完成第二次上传和两次推理。现有服务未升级或重启。
固定源码未建立可确认的删除入口，两份合成测试文件可能仍留在账户存储中。
本记录不包含真实文件编号，因此不能作为删除操作的目标清单。

## 官方 Platform Files API 与本次链路的区别

固定源码未补齐取回能力，因此另核对官方在线文档（2026-09-23 UTC）：
Platform 提供[文件内容下载](https://developers.openai.com/api/reference/resources/files/methods/content)
和[文件删除](https://developers.openai.com/api/reference/resources/files/methods/delete)，
使用[API 认证](https://developers.openai.com/api/reference/overview#authentication)。
这些文档不构成本次 ChatGPT Apps 上传编号与 Platform 文件存储互通的证据；
没有把 ChatGPT Token 发给 Platform，也没有对这两份测试文件尝试 Platform 删除。

| 路径 | 已有依据 | 剩余条件 |
| --- | --- | --- |
| ChatGPT Apps 文件 | 固定源码上传、即时下载，以及当前账户在线图片引用成功 | 生产认证归属与刷新、独立取回、删除/过期合同、精确版本在线端到端验证 |
| Platform Files API | 官方有上传、内容下载与删除接口 | 独立 API 认证、文件用途与模型互通的真实验证；不能直接代替 ChatGPT 文件 |
| Gateway 临时图片 | 项目已有 Surface 临时媒体与 Data URL 路径 | 若选择复用，须明确本地引用与清理范围；它不是原生文件编号方案 |

未新增 Platform 凭据配置或生产文件管理入口；Client 内部的自动引用转换已撤除，渠道保持官方内联输入路径，保留引用协议合同与本记录中的探测证据。自动引用尚未交付，当前决定和后续条件见[升级决策](codex-cli-upgrade-decisions.md#图片文件引用需求阻塞与实现边界)。
