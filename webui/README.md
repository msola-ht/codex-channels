# Codex WebUI 前端

`codexc webui` 的本地指标与低风险设置前端。Vite + React 19 + TypeScript，UI 组件全部来自
shadcn（`npx shadcn@latest add` 安装），业务层只做组件组合与数据编排。

## 开发

```bash
npm install
npm run dev        # Vite dev server（API 走 /api/v1，需同时运行 codexc webui）
npm run build      # 产出 webui/dist，由 codexc webui 托管
npm run lint       # oxlint
```

## 结构

```text
.npmignore  覆盖本目录的 Git 忽略规则，确保构建后的 dist 进入 npm tarball
src/
  lib/         API 客户端、令牌存取、共享类型转出与格式化；api-polling.ts 管理请求结束后的刷新计时与页面可见性，format.ts 统一服务端时区展示，trend.ts 按服务端日期补齐日图表并呈现单日小时统计；metrics-query.ts 统一查询参数和逐层跳转地址，overview-state.ts 保证控制台快照属于当前加载批次，account-refresh-state.ts 区分 DS、OCG、CCG 账户快照时效与逐账户刷新结果，traffic-state.ts 隔离不同转储查询的结果并生成精确关联地址
  hooks/       数据 hook（useApi 统一 loading/error/refetch，useApiPolling 复用自动刷新调度，use-dashboard 整批加载概览、趋势和热力图，use-server-time 在页面呈现前初始化服务端时区）、use-metrics-query（URL 筛选/排序/分页）、use-traffic-query（调用详情页 URL 提供商、批次筛选、独立明细提供商/批次与分页）、use-metrics-export（可取消请求导出）、use-traffic（转储列表与明细）、设置管理（共用版本化预览/确认状态机）与全局货币上下文
  components/  layout（Sidebar）、overview（控制台卡片、account-refresh-feedback 刷新反馈、account-subscription-notice 订阅状态与确认删除）、metrics（指标区块、query-filters 共用筛选栏、query-summary 期间汇总与共享数据表格）、requests（请求明细数据表格）、traffic（调用摘要、明细、traffic-model 共用模型名称对照、请求内容/参数对照与清理入口）、settings（按设置域拆分的卡片与控件）
  pages/       概览、Threads、Thread 详情、请求、错误、调用详情、设置（只负责组合设置域组件）
  App.tsx      路由布局与页面级懒加载，保留页面切换间的控制台已应用范围（令牌登录由 AuthGate 与 main.tsx 启动入口协作）
```

令牌登录：服务端配置访问令牌时，API 返回 401 会显示令牌输入页；令牌存入浏览器
`localStorage`，重新打开浏览器仍可复用，也可用 `?token=` 查询参数（放在 `#` 前或 HashRouter 路径中均可）打开页面自动登录。
该令牌同时用于指标读取和设置页的低风险预览/修改。

全局深色/浅色主题默认深色，右上角按钮切换，选择存入浏览器 `localStorage`
（`next-themes`），刷新后保持。

API 响应类型不是前端手写镜像：`src/lib/types.ts` 只转出
`scripts/webui-api.ts` 的共享声明，服务端与前端使用同一份类型。

## UI 组件规范

- 基础 UI 组件放在 `components/ui/`，只通过 `npx shadcn@latest add` 安装或升级，
  不手写基础组件（按钮、卡片、表格、弹层等）；
- 业务组件按领域分目录组合：`components/layout/`（布局与鉴权）、
  `components/overview/`、`components/threads/`、`components/metrics/`（指标区块），
  `components/requests/`（请求明细数据表格），只做组件组合与数据编排，不直接发请求；
- 数据获取统一走 `hooks/`（`useApi` 系列，集中 loading/error/refetch；设置变更共用版本化预览/确认 Hook），组件不直接
  `fetch`（唯一例外：`AuthGate` 在提交令牌前用原始请求验证一次）；API 路径统一从
  `src/lib/api.ts` 的 `API_PREFIX` 拼接；
- 类型从 `src/lib/types.ts` 转出，格式化（Token/时间）放 `src/lib/format.ts`；时间预设标签放 `src/lib/metrics-query.ts`，
  控制台与各查询页复用 `components/metrics/range-selector.tsx` 的时间及日期控件；
  `use-metrics-query` 读取 Provider 筛选选项并保留多选 URL 参数，`query-filters` 使用勾选下拉；
- 页面（`pages/`）只负责组合区块与路由参数，业务规则不写进页面；
- 遵守 oxlint 规则：Hooks 必须在组件顶层调用，文件默认只导出组件
  （`react/only-export-components`）。

详细行为见 `docs/webui.md`。

`components/settings/tool-access-settings.tsx` 组合电脑、浏览器与已有 MCP 的原生配置编辑器，复用 App Server 设置 Hook 的版本化预览和确认；用户层与合并配置分开展示。

调用详情正文复用 `components/traffic/traffic-content.tsx` 的延迟展开与只读文本操作组件，统一复制、换行、格式化和截断提示。

`components/metrics/service-tier.tsx` 为请求明细、错误记录和调用详情提供 Fast 标签；前两者使用请求层级，调用详情区分请求与响应来源。
`components/metrics/data-table.tsx` 的 `TruncatedText` 按实际溢出显示全文提示，`SortableHeader` 复用排序按钮展示列口径；提示延迟由 `App.tsx` 的 Provider 统一设置。
