# Provider Proxy

本目录提供模型 Provider 的本地回环转发代理，用于在 Gateway 进程内观测模型 API 的流式响应。

## 文件

- `proxy.ts`：HTTP 转发实现。监听回环地址，把 `/responses` 请求原样转发到上游
  Provider（只改写 `Host`），透传全部请求头（含 Authorization，不落日志、不进指标）；
  转发 SSE 响应时按事件类型记录推理流和可见输出流的首尾时间，并从
  `x-codex-turn-metadata` 提取 `thread_id` / `turn_id` 用于按 Turn 关联。
  只转发 `/responses` 路径，其余路径返回 404；监听地址强制为回环（模块与配置双重校验），
  上游空闲超时默认 60 秒并处理流式背压；客户端提前断开时取消上游请求。
- `index.ts`：公开 `ProviderProxy` 与指标类型。

模块只依赖 Node 内置 HTTP/HTTPS 能力，不接触平台 SDK、数据库或协议生成类型；由
`bootstrap` 组装生命周期并把指标转换为 `conversation-core` 的稳定输入事件。
监听地址必须由配置层限制为回环地址；代理失败按配置错误失败关闭。
