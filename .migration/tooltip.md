# tooltip

2026-10-02 · golden pair via CLI / merge · 已迁移。

## Changed

- `webui/src/components/ui/tooltip.tsx`
- `webui/src/App.tsx`
- `webui/src/components/layout/mode-toggle.tsx`
- `webui/src/components/metrics/data-table.tsx`
- `webui/src/components/metrics/token-tooltip.tsx`
- `webui/src/components/requests/requests-table.tsx`
- `webui/src/components/threads/turn-table.tsx`
- `webui/src/components/ui/sidebar.tsx`

保留卡片色背景，使用 Positioner；Provider delay=400、timeout=0 延续原延迟设置。

已检查本组件及受影响业务文件，无 radix-ui、@radix-ui 或 asChild 残留。

## Left alone

保留现有主题、业务接口与服务端实现；Recharts 等独立库不替换。共享 cn 导入已统一。

## Behavior changes

Base Tooltip 默认是视觉提示，不自动生成读屏描述。表头、Token 明细和错误摘要的业务触发元素显式提供 `aria-description`，图标按钮保留可访问名称；截断文本的完整内容仍在 DOM 中。Provider 使用 Base 1.8 的 `delay=400`、`timeout=0` 保持原悬停延迟。

## Verify by hand

在中文和英文下打开相关页面；通过 Tab 与 Enter 操作，检查禁用状态与窄屏布局。弹层检查 Esc、外部点击和关闭后焦点；选择框检查标签与键盘选择；侧栏检查折叠与移动端关闭。
