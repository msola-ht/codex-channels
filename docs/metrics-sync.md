# 多设备指标同步

每台设备各自运行 Gateway 并维护本地指标库。`[metrics.sync]` 让本机 Gateway 把脱敏的模型
请求指标和子代理标注增量上报到中心服务，供汇总后统一查看。

## 当前状态

- 本地设备侧（本仓库）：已实现增量读取、批量上报、水位持久化和失败退避。
- 中心侧（VPS 自建）：本仓库提供 `codexc center` 中心服务，写入中心 SQLite，
  WebUI 通过 `/api/v1/global/*` 服务端代理查看所有设备累计。
- 校验：中心服务用 `device_token` 校验设备上报、用独立 `token` 校验只读查询；本机分别在
  上报请求和 WebUI 服务端代理中携带对应 Bearer 令牌，令牌不进入前端。

## 设备侧配置

```toml
[metrics.sync]
enabled = true
endpoint = "http://127.0.0.1:8790/api/ingest"   # 或 https://中心服务器/api/ingest
device_token = "中心分发的设备令牌"
device_name = "Mac Pro"        # 可选；不填时使用系统名称，可含空格、-、_
batch_size = 200              # 每次上报的请求条数上限，1–500，默认 200
interval_seconds = 60         # 上报间隔，10–86400，默认 60
```

- `enabled = true` 时必须配置 `endpoint` 和 `device_token`。`endpoint` 使用 HTTPS，
  或指向回环/私网地址的 HTTP；公网地址必须 HTTPS。
- 设备 ID 不需要手工配置。首次上报前自动生成 UUID 并持久化，之后保持不变，仅用于设备身份、
  去重和筛选。
- `device_name` 可选，填写后作为唯一设备显示名和上报名称，支持空格、连字符和下划线，最长 128
  个字符；留空时使用系统主机名。中心和 WebUI 使用同一个名称，不再分别维护名称。
- `device_token` 是敏感凭据，只放在请求头中，不写入日志。
- 每次上报携带配置的 `device_name`（未配置时为系统主机名）作为 `deviceName`；中心保存该名称并
  直接用于 WebUI 展示。名称只用于展示，不影响设备 ID、水位或去重。

### 本机接入设置

运行 `codexc config`，选择「数据中心 → 本机接入数据中心」，输入中心地址、设备上报令牌、
全局查看令牌和可选设备名称，即可同时写入 `[metrics.sync]` 与 `[metrics.view]`。菜单还提供「查看数据中心状态」
「本机上报参数」（`interval_seconds` 与 `batch_size`）和「停用本机接入」（停用保留配置，可随时
重新接入）。手工编辑 `config.toml` 效果相同；重新接入或停用本机接入时会先备份原配置，
其他参数修改不复制整份配置。远程
中心服务端设置也可从 `codexc config → 数据中心 → 数据中心服务（本机）` 进入；独立的
`codexc center config` / `codexc center info` 命令仍然保留。

## WebUI 全局视图配置

每台设备的 WebUI 都可以查看所有设备累计，读取的是中心服务而不是本地库：

```toml
[metrics.view]
enabled = true
endpoint = "http://127.0.0.1:8790"   # 中心地址，不带 /api/ingest
token = "中心访问令牌"
```

- `enabled = true` 时必须配置 `endpoint` 和 `token`；`endpoint` 使用 HTTPS，或指向
  回环/私网地址的 HTTP（公网地址必须 HTTPS）。
- WebUI 服务端携带该令牌访问中心，令牌不进入前端；`/api/v1/global/*` 不可达时返回
  `metrics_view_unavailable` / `metrics_view_unreachable`。
- 「本机接入数据中心」会把查看令牌写入 `[metrics.view].token`，把设备上报令牌写入
  `[metrics.sync].device_token`；两者属于不同用途，必须保持不同。

## 中心服务（VPS）

```toml
[metrics.center]
enabled = true
host = "127.0.0.1"            # 公网开放用 0.0.0.0，但必须设置下面两类令牌
port = 8790
token = "中心只读查看令牌"
device_token = "设备上报令牌" # 必须与 token 不同
database_path = "data/central-metrics.sqlite3"
```

启动：

```bash
codexc center config              # 远程端交互配置 [metrics.center]（监听、端口、双令牌、数据库）
codexc center info                # 查看中心地址、双令牌状态与运行状态（获取设备上报地址）
codexc center upgrade             # 升级已有中心数据库并保留升级前备份
codexc service install               # 生成 WebUI 与指标中心服务单元（首次）
codexc service start center          # 启动指标中心后台服务
```

- 中心库是独立 SQLite（默认 `~/.codex-connect/data/central-metrics.sqlite3`），
  主键 `(device_id, local_id)`，按主键 `ON CONFLICT ... DO UPDATE` 覆盖写入；重复上报
  不会新增行，但会用最新值覆盖该条记录，因此重置本机水位后全量重放可修复云端历史。表结构与
  [`cloudflare/migrations/0001_init.sql`](../cloudflare/migrations/0001_init.sql) 一致。
- 中心库使用独立 Schema 版本。服务启动不会自动修改已有表；升级时先停止中心服务，运行
  `codexc center upgrade`，命令会在数据库旁创建带版本和时间戳的 `0600` 备份，完成受控升级后
  才允许服务重新启动。Schema 不受支持或结构不完整时会失败关闭。
- 接口：`POST /api/ingest` 接收上报，`GET /api/overview`、`/api/requests`、
  `/api/subagents`、`/api/devices`、`/api/health` 供查询。
- WebUI 控制台的「全部设备 / 单设备」范围通过 `/api/v1/global/*` 由 WebUI 服务端
  带令牌读取中心服务，前端不接触令牌；每台设备的 WebUI 都可以看到所有设备累计，
  明细页（Threads、请求、错误）保持只读本机指标库。
- 渠道额度估算把额度周期与本地观测分开：周期开始由窗口长度和上游重置时间推导，历史中检测到
  下一周期提前出现时以其起点修正上一周期结束；Token、使用率增量和容量估算仍只使用本地实际
  观测到的请求区间。没有相邻快照时不会猜测未观测到的重置时刻。
- `POST /api/ingest` 只接受 `device_token`；只读查询只接受 `token`，两者必须不同；绑定
  `0.0.0.0` 时必须同时配置，并建议用 nginx/Caddy 套 HTTPS。

## Cloudflare 版本（已停用）

此前曾部署 Cloudflare Worker + D1 + Pages 查看页（`cloudflare/` 目录仍保留，含部署说明），
当前已停止上报并停用，后续以 VPS 中心服务为准。

## 行为

- 启动后立即执行一次，之后按 `interval_seconds` 定时执行；失败时按
  `间隔 × 2^失败次数` 指数退避，最长 1 小时，成功后退避清零；429/5xx 且服务端返回
  `Retry-After` 时，按服务端要求的时间延后重试（不会早于该时间发起请求）。
- 需要修复云端历史时，运行 `codexc metrics sync-reset [--restart-gateway]`：默认要求
  Gateway 已停止，备份并清零本地上报水位（保留设备 ID），Gateway 重启后从第一条记录
  重新上报；中心按 `(device_id, local_id)` 覆盖写入，重复记录用最新值覆盖而不是新增。
  加 `--restart-gateway` 时自动停止并重新启动 Gateway。
- 每次从本地指标库读取 `id > 上次水位` 的请求记录（最多 `batch_size` 条）和
  `recorded_at_ms > 上次水位` 的子代理标注（最多 1000 条；同一毫秒内用 `thread_id`
  复合游标继续推进，避免同毫秒落库的记录漏传）；两者都为空时不发请求。
- 只有收到 HTTP 2xx 后才推进水位并持久化；失败不推进，下次重试仍从旧水位开始，
  不会漏传。
- 上报不阻塞 Gateway 主流程；Gateway 关闭时中止在途请求并停止定时器。
- 上报只包含脱敏指标，不含消息正文、提示词、图片、识别结果、审批内容，也不上传
  `errorMessage` 原始错误文本。指标保留期以本地 `[metrics.storage]` 为准，默认 365 天、
  最多 1,000,000 行；中心已接收的历史不会因本地自动清理而删除。

## 本地状态文件

设备标识与水位保存在 `~/.codex-connect/data/metrics-sync-state.json`
（与 `request-metrics.sqlite3` 同目录），权限 `0600`，原子写入。文件损坏或缺失时自动
重建，并记录告警。

## 上报载荷

```json
{
  "deviceId": "device-a",
  "deviceName": "main-server",
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

`localId` 是本地指标库的自增主键；中心库以 `(device_id, local_id)` 为主键，
用 UPSERT 幂等覆盖同一记录，使水位重置后的完整重放可以修复中心历史。完整字段与本地
`model_request_metrics_enriched` 视图一致（不含 `error_message`）。
