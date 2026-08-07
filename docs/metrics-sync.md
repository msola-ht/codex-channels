# 多设备指标同步

每台设备各自运行 Gateway 并维护本地指标库。`[metrics.sync]` 让本机 Gateway 把脱敏的模型
请求指标和子代理标注增量上报到中心服务，供汇总后统一查看。

## 当前状态

- 本地设备侧（本仓库）：已实现增量读取、批量上报、水位持久化和失败退避。
- 中心侧（Cloudflare Worker + D1 + Pages 前端）：已部署上线，包含 Worker
  `codex-metrics-sync`、D1 数据库 `codex-metrics` 和 Pages 查看页
  `codex-metrics-viewer`；仓库骨架与部署步骤见
  [`cloudflare/README.md`](../cloudflare/README.md)。
- 校验：`device_token` 只由中心 Worker 校验，不做前端登录页；本机只负责携带
  `Authorization: Bearer <device_token>` 上报。

## 配置

```toml
[metrics.sync]
enabled = true
endpoint = "https://metrics.example.com/ingest"
device_token = "中心分发的设备令牌"
device_id = "device-a"        # 可选；不填时首次运行自动生成并持久化
batch_size = 200              # 每次上报的请求条数上限，1–500，默认 200
interval_seconds = 60         # 上报间隔，10–86400，默认 60
```

- `enabled = true` 时必须配置 `endpoint` 和 `device_token`；`endpoint` 只接受 HTTPS。
- `device_id` 可选，格式为 `^[a-z0-9][a-z0-9_-]{0,63}$`。不配置时首次上报前自动生成
  UUID 并持久化，之后保持不变；配置后以配置值为准。
- `device_token` 是敏感凭据，只放在请求头中，不写入日志。

## 行为

- 启动后立即执行一次，之后按 `interval_seconds` 定时执行；失败时按
  `间隔 × 2^失败次数` 退避，最长 1 小时，成功后退避清零。
- 每次从本地指标库读取 `id > 上次水位` 的请求记录（最多 `batch_size` 条）和
  `recorded_at_ms > 上次水位` 的子代理标注（最多 1000 条；同一毫秒内用 `thread_id`
  复合游标继续推进，避免同毫秒落库的记录漏传）；两者都为空时不发请求。
- 只有收到 HTTP 2xx 后才推进水位并持久化；失败不推进，下次重试仍从旧水位开始，
  不会漏传。
- 上报不阻塞 Gateway 主流程；Gateway 关闭时中止在途请求并停止定时器。
- 上报只包含脱敏指标，不含消息正文、提示词、图片、识别结果、审批内容，也不上传
  `errorMessage` 原始错误文本。指标保留期仍以本地库 30 天为准。

## 本地状态文件

设备标识与水位保存在 `~/.codex-connect/data/metrics-sync-state.json`
（与 `request-metrics.sqlite3` 同目录），权限 `0600`，原子写入。文件损坏或缺失时自动
重建，并记录告警。

## 上报载荷

```json
{
  "deviceId": "device-a",
  "requestMetrics": [
    {
      "localId": 42,
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "status": "completed",
      "inputTokens": 1000,
      "cachedInputTokens": 900,
      "outputTokens": 100,
      "totalCostNanos": 6000
    }
  ],
  "subagentThreads": [
    {
      "threadId": "sub-1",
      "parentThreadId": "main-1",
      "agentPath": "/root/ds_probe",
      "recordedAtMs": 1780000000000
    }
  ]
}
```

`localId` 是本地指标库的自增主键；中心库建议以 `(device_id, local_id)` 为主键，
用 `INSERT OR IGNORE` 幂等去重。完整字段与本地 `model_request_metrics_enriched` 视图
一致（不含 `error_message`）。
