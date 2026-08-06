# 本地指标 WebUI

`codexc webui` 启动本地只读指标 WebUI，展示模型请求指标数据库（`request-metrics.sqlite3`）
中的全局统计、会话、请求明细与错误聚合。WebUI 不读取业务会话库，不提供任何写接口。

## 命令

```text
codexc webui [--host 127.0.0.1|::1|0.0.0.0] [--port 端口] [--token 令牌]
```

- 默认监听 `127.0.0.1:8787`，无令牌即可访问；
- `--host 0.0.0.0` 绑定所有网卡（公网/局域网访问）；建议同时提供 `--token` 访问令牌，
  API 使用 `Authorization: Bearer <令牌>` 校验；未提供令牌时启动会打印
  “指标数据对网络公开”的警告，仅供测试使用；
- 前端在 API 返回 401 时显示令牌输入页；也可以通过
  `http://<地址>:<端口>/?token=<令牌>` 直接携带令牌打开（令牌会出现在浏览器历史，谨慎使用）。

## 页面与 API

| 页面 | 路由 | API |
| --- | --- | --- |
| 概览 | `#/` | `GET /api/v1/overview?range=24h\|7d\|30d` |
| Threads | `#/threads` | `GET /api/v1/threads` |
| Thread 详情 | `#/threads/:id` | `GET /api/v1/threads/:id/run`、`GET /api/v1/threads/:id/turns` |
| 请求明细 | `#/requests` | `GET /api/v1/requests?range=&afterId=&limit=` |
| 错误 | `#/errors` | `GET /api/v1/errors?range=` |

所有接口只接受 GET；`range` 只支持 `24h`、`7d`、`30d`；请求分页 `limit` 1–500。
概览全局费用支持人民币/美元切换，选择保存在浏览器 `localStorage`
（键 `codex-webui:currency`）。

API 响应类型由 `scripts/webui-api.ts` 声明，前端从该共享类型导入，不再单独手写镜像。

## 架构

```text
Gateway 指标收集 ──> request-metrics.sqlite3（指标数据库）
                            │ 只读
                            ▼
              scripts/webui-server.mjs（codexc webui 服务）
                ├─ /api/v1/* 只读 JSON API（Observability Store 只读模式）
                └─ webui/dist 静态托管
                            ▲
                            │ /api/v1/*（同源，令牌可选）
              webui/（Vite + React 前端）
                ├─ lib/  API 客户端、格式化
                ├─ hooks/ 数据 hook
                ├─ components/ 布局与指标区块
                └─ pages/ 页面组合
```

- 服务端只读查询复用 `codexc metrics` 的同一能力（`metrics-database.mjs` /
  `metrics-export-format.mjs`），不维护平行索引；
- API 响应类型单一来源是 `scripts/webui-api.ts`，前端只做转出；
- 前端构建产物随 npm 包发布，`codexc webui` 不依赖源码目录即可托管。

## 价格口径

- Provider 分组按 `price_currency` 配置换算：DeepSeek 默认人民币，OpenAI 默认美元；
- 全局费用为混合 Provider 参考价，人民币显示使用统一汇率换算
  （`data/exchange-rate.json`），无汇率时保持原币种；
- 均价按“总费用 ÷ 总 Token（输入 + 输出，含压缩）× 1 亿”展示为 `/100M`。

## 边界与安全

- 默认只监听回环地址；绑定非回环地址时建议启用访问令牌，令牌比较使用常数时间算法，
  令牌只存浏览器 `sessionStorage`，关闭标签页失效；
- 无任何写接口，指标数据库以只读模式打开；
- 静态资源按白名单扩展名提供，路径限制在 `webui/dist` 内。

边界约束：

- WebUI 不读取、不解析业务会话库，也不连接 App Server；
- 不提供写接口，不修改用户配置、指标数据库或任何持久化状态；
- API 只接受 GET；未知 API 与非 `/api/v1` 前缀统一返回 JSON 404；
- 令牌只用于 API 鉴权，不写入 `localStorage`，不进入日志或响应体。

## 前端

前端是独立的 Vite + React 子项目（`webui/`），UI 全部使用 shadcn 组件：

```text
webui/src/
  lib/         API 客户端、共享类型转出与格式化（价格/Token/耗时）
  hooks/       资源数据 hook（统一 loading/error/refetch）
  components/  Sidebar 布局与指标区块组件
  pages/       概览、Threads、Thread 详情、请求、错误
```

构建：`cd webui && npm run build`，产物 `webui/dist/` 由 `codexc webui` 托管并随 npm 包发布。
