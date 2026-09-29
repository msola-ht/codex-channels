# Model Relay

独立模型 API 入口的身份、准入和请求生命周期模块，不依赖 App Server、Thread、Turn 或数据库。
由 Runtime 的独立服务入口组合；生产运行验收与跨平台实机验收仍需单独完成。

- `index.ts`：公开模块能力。
- `admission.ts`：内存身份快照、常数时间秘密哈希比较、全局/账户/Key 令牌桶与并发许可、撤销和关闭。
- `server.ts`：回环 HTTP、异步准备后的出站复核、Chat JSON/SSE 交付、请求关闭及一次性指标生成；错误响应提供受控原因、阶段、上游状态与指标关联编号。
- `metrics-sender.ts`：有界单次指标发送、四类确认结果、零重试与限时关闭。

Runtime 注入已验证的配置、Provider 材料与网络目标；本模块不解析账户文件或凭据路径。
协议验证通过 `model-api` 公共入口，网络能力通过 `provider-proxy` 公共入口。指标仅通过注入端口
送往 Gateway 单写者，不生成 Core 事件或渠道输出。
