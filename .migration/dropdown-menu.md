# dropdown-menu

2026-10-02 · golden pair via CLI / merge · 已迁移。

## Changed

- `webui/src/components/ui/dropdown-menu.tsx`
- `webui/src/components/metrics/data-table.tsx`
- `webui/src/components/metrics/language-toggle.tsx`
- `webui/src/components/metrics/query-filters.tsx`
- `webui/src/components/settings/relay-model-copy.tsx`
- `webui/src/pages/relay-page.tsx`

操作回调由 onSelect 改为 onClick；筛选多选显式 closeOnClick=false。

已检查本组件及受影响业务文件，无 radix-ui、@radix-ui 或 asChild 残留。

## Left alone

保留现有主题、业务接口与服务端实现；Recharts 等独立库不替换。共享 cn 导入已统一。

## Behavior changes

Base 复选菜单默认选择后保持打开，列显隐菜单采用此行为，方便连续选择；操作菜单执行后关闭。

## Verify by hand

在中文和英文下打开相关页面；通过 Tab 与 Enter 操作，检查禁用状态与窄屏布局。弹层检查 Esc、外部点击和关闭后焦点；选择框检查标签与键盘选择；侧栏检查折叠与移动端关闭。
