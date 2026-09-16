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
  lib/         API 客户端、令牌存取、共享类型转出与格式化；metrics-query.ts 统一查询参数和逐层跳转地址，overview-state.ts 保证控制台结果属于当前加载批次
  hooks/       数据 hook（useApi 统一 loading/error/refetch，use-dashboard 协调概览与趋势的加载批次）、use-metrics-query（URL 筛选/排序/分页）、use-metrics-export（可取消请求导出）、设置管理（共用版本化预览/确认状态机）与全局货币上下文
  components/  layout（Sidebar）、metrics（指标区块、query-filters 共用筛选栏、query-summary 期间汇总与共享数据表格）、requests（请求明细数据表格）、settings（按设置域拆分的卡片与控件）
  pages/       概览、Threads、Thread 详情、请求、错误、设置（只负责组合设置域组件）
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
