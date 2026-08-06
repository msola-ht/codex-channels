# Codex WebUI 前端

`codexc webui` 的本地只读指标前端。Vite + React 19 + TypeScript，UI 组件全部来自
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
src/
  lib/         API 客户端、共享类型转出与格式化
  hooks/       数据 hook（useApi 统一 loading/error/refetch）
  components/  layout（Sidebar）、metrics（指标区块）
  pages/       概览、Threads、Thread 详情、请求、错误
  App.tsx      路由布局与令牌登录（AuthGate）
```

令牌登录：服务端配置 `--token` 时，API 返回 401 会显示令牌输入页；令牌存入
`sessionStorage`，也可用 `?token=` 查询参数打开页面自动登录。概览全局费用
的人民币/美元选择存入 `localStorage`（`codex-webui:currency`）。

API 响应类型不是前端手写镜像：`src/lib/types.ts` 只转出
`scripts/webui-api.ts` 的共享声明，服务端与前端使用同一份类型。

## UI 组件规范

- 基础 UI 组件放在 `components/ui/`，只通过 `npx shadcn@latest add` 安装或升级，
  不手写基础组件（按钮、卡片、表格、弹层等）；
- 业务组件按领域分目录组合：`components/layout/`（布局与鉴权）、
  `components/overview/`、`components/threads/`、`components/metrics/`（指标区块），
  只做组件组合与数据编排，不直接发请求；
- 数据获取统一走 `hooks/`（`useApi` 系列，集中 loading/error/refetch），组件不直接
  `fetch`；API 路径统一从 `src/lib/api.ts` 的 `API_PREFIX` 拼接；
- 类型从 `src/lib/types.ts` 转出，格式化（价格/Token/耗时）放 `src/lib/format.ts`；
- 页面（`pages/`）只负责组合区块与路由参数，业务规则不写进页面；
- 遵守 oxlint 规则：Hooks 必须在组件顶层调用，文件默认只导出组件
  （`react/only-export-components`）。

详细行为见 `docs/webui.md`。
