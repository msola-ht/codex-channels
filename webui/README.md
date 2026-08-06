# Codex WebUI 前端

`codexc webui` 的本地只读指标前端。Vite + React 19 + TypeScript，UI 组件全部来自
shadcn（`npx shadcn@latest add` 安装），业务层只做组件组合与数据编排。

## 开发

```bash
npm install
npm run dev        # Vite dev server（API 走 /api，需同时运行 codexc webui）
npm run build      # 产出 webui/dist，由 codexc webui 托管
npm run lint       # oxlint
```

## 结构

```text
src/
  lib/         API 客户端、类型与格式化
  hooks/       数据 hook（useApi 统一 loading/error/refetch）
  components/  layout（Sidebar）、metrics（指标区块）
  pages/       概览、Threads、Thread 详情、请求、错误
  App.tsx      路由布局与令牌登录（AuthGate）
```

令牌登录：服务端配置 `--token` 时，API 返回 401 会显示令牌输入页；令牌存入
`sessionStorage`，也可用 `?token=` 查询参数打开页面自动登录。概览全局费用
的人民币/美元选择存入 `localStorage`（`codex-webui:currency`）。

详细行为见 `docs/webui.md`。
