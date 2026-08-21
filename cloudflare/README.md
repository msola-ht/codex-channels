# Cloudflare 中心侧（Worker + D1 + Pages）

> 已停用：当前多设备汇总以 VPS 中心服务（`codexc center`）为准，
> 本目录仅保留历史实现与部署参考，不再接收上报。

接收各设备 Gateway 的增量指标上报，汇总到 D1，并提供只读 API 与静态查看页。
令牌校验只发生在 Worker：`POST /api/ingest` 必须携带
`Authorization: Bearer <INGEST_TOKEN>`。查看 API 默认公开只读，建议用
Cloudflare Access 保护 Pages 与 Worker 域名，不在前端做登录页。

## 目录

- `migrations/0001_init.sql`：D1 初始表结构（请求指标、子代理标注、设备）。
- `migrations/0002_parent_turn_id.sql`：为子代理标注增加可空 `parent_turn_id`；部署迁移期间仍接受
  缺少该字段的旧上报载荷，缺失值保持 `NULL`，不按时间推断父 Turn。
- `worker/src/index.js` / `worker/src/index.d.ts`：Worker 入口及其测试用窄类型声明，`/api/ingest` 写入、`/api/overview`、
  `/api/requests`、`/api/subagents`、`/api/devices` 查询、`/api/health`。
- `worker/src/payload.js`：兼容导出共享的 `scripts/metrics-center-payload.mjs` 上报载荷校验。
- `pages/`：静态查看页（无构建步骤，直接部署）。

## 已部署实例

- Worker：`https://codex-metrics-sync.lunare.workers.dev`
- 上报端点：`https://codex-metrics-sync.lunare.workers.dev/api/ingest`
- 查看页：`https://codex-metrics-viewer.pages.dev/`
- D1：`codex-metrics`（region WNAM）

## 部署

1. 登录并创建 D1 数据库：

```bash
cd cloudflare
npx wrangler login
npx wrangler d1 create codex-metrics
```

2. 把输出里的 `database_id` 填进 `wrangler.jsonc` 的
   `d1_databases[0].database_id`（替换 `<D1_DATABASE_ID>`）。

3. 应用表结构：

```bash
npx wrangler d1 migrations apply codex-metrics --remote
```

4. 设置上报令牌（Worker 只接受这个 Bearer Token）：

```bash
npx wrangler secret put INGEST_TOKEN
```

5. 部署 Worker：

```bash
npx wrangler deploy
```

部署后 Worker 地址形如 `https://codex-metrics-sync.<你的子域>.workers.dev`，
把它填到各设备 `config.toml` 的 `metrics.sync.endpoint`（加 `/api/ingest` 路径）。

6. 部署静态查看页：

```bash
npx wrangler pages deploy pages --project-name codex-metrics-viewer
```

把 `pages/app.js` 顶部的 `defaultApiBase` 改成你的 Worker 地址。

## 数据模型

- `request_metrics`：主键 `(device_id, local_id)`，`INSERT OR IGNORE` 幂等去重；
  `payload` 保存该条脱敏指标完整 JSON，关键字段拆列用于查询与汇总。
- `subagent_threads`：主键 `(device_id, thread_id)`，更新会覆盖同线程标注；`parent_turn_id` 只在
  新载荷显式提供时写入，旧数据保持空值。
- `devices`：设备首次/最后上报时间，用于查看页展示设备状态。

## 安全边界

- 上报只接受 HTTPS 来源（本地配置已强制）并校验载荷结构与大小上限。
- `INGEST_TOKEN` 不进代码、不进前端、不写日志。
- 查看 API 是只读聚合；部署时用 Cloudflare Access 限制访问者，避免公开用量数据。
