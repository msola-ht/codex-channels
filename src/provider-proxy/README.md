# Provider Proxy

本目录提供模型 Provider 的本地回环转发代理及私有指标通道。模型数据通路由 App Server 服务
持有，Gateway 只接收可丢失的计时指标，因此 Gateway 停止或重启不会中断模型请求。

## 文件

- `proxy.ts`：HTTP/SSE 与 WebSocket 转发实现。监听自动分配的回环地址，把精确
  `/responses`、HTTP `/responses/compact` 与只读 `/models` 路径转发到上游
  Provider，保留端到端状态码与响应头；Authorization 只用于上游请求，不落日志、不进指标，
  `x-codex-turn-metadata` 在本地读取后移除，Hop-by-hop Header 不透传；
  转发 SSE 或 WebSocket 响应时按事件类型记录首 Token、推理与非推理输出首尾时间，并在
  响应完成事件前完成指标投递确认；从
  `x-codex-turn-metadata` 提取 `thread_id` / `turn_id` 用于按 Turn 关联。
  其他路径以及非 GET 的 `/models` 返回 404；监听地址强制为回环，
  上游空闲超时默认 60 秒并处理双向流式背压；客户端提前断开时取消上游请求。服务入口按统一
  `network.proxy` 选择传入上游 Agent。
- `metrics-channel.ts`：App Server 服务把单条有界指标写入 Gateway 拥有的 `0600` Unix Socket，
  接收端归约后返回确认，保证短回复的 Turn 完成事件不会抢先清理计时状态；Gateway 不在线时指标
  直接丢弃并继续模型响应。接收端拒绝非 Socket、非当前用户或已被活动进程占用的路径，并只删除
  自己创建的 Socket；监听建立后的权限检查失败也会关闭监听并清理自身路径。
- `index.ts`：公开代理、指标通道和稳定指标类型。

模块只依赖 Node 内置 HTTP/HTTPS/Unix Socket 能力，不接触平台 SDK、数据库或协议生成类型；
`bin/codexc.mjs` 把代理装配到 App Server 服务生命周期，`bootstrap` 只把收到的指标转换为
`conversation-core` 的稳定输入事件。
App Server 服务为主 Provider 和可选切换 Provider 自动创建独立代理，不暴露手工监听配置。
OpenAI 保留用户配置的 `openai_base_url`；没有显式上游时，按官方认证请求 Header 选择 ChatGPT
或 API 上游。代理启动失败时 App Server 服务失败关闭，不以绕过统计代理的方式静默降级。
