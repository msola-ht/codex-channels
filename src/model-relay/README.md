# Model Relay

独立模型 API 入口的身份、准入和请求生命周期模块，不依赖 App Server、Thread、Turn 或数据库。
由 Runtime 的独立服务入口组合；生产运行验收与跨平台实机验收仍需单独完成。

- `index.ts`：公开模块能力。
- `admission.ts`：内存身份快照、常数时间秘密哈希比较、全局令牌桶与并发许可、有界上传/等待预算及按 Key 公平调度、撤销和关闭。
- `server.ts`：回环 HTTP、异步准备后的出站复核、Chat JSON/SSE 交付、请求关闭及一次性指标生成（含实际出站 User-Agent，缺失不推断）；错误响应提供受控原因、阶段、上游状态与指标关联编号。
- `metrics-sender.ts`：有界单次指标发送、四类确认结果、零重试与限时关闭。

Runtime 注入已验证的配置、Provider 材料与网络目标；本模块不解析账户文件或凭据路径。
协议验证通过 `model-api` 公共入口，网络能力通过 `provider-proxy` 公共入口。指标仅通过注入端口
送往 Gateway 单写者，不生成 Core 事件或渠道输出。

等待队列仅在内存中：上传/等待最多 32 个、正文预算 16 MiB、排队最多 30 秒；取消/撤销/关闭
释放等待资源，不自动重放。等待不占执行许可，不生成上游指标；diagnostics 提供无正文的计数。

`ModelRelayServer` 可注入独立 Chat 采集器；未启用时不采集正文，最终指标只携带受限 V2 定位。
旁路脱敏、容量与文件生命周期归 provider-proxy 公共能力，Relay 不操作指标数据库。
