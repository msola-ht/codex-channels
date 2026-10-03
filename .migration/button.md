# button

2026-10-02 · golden pair via CLI / merge · 已迁移。

## Changed

- `webui/src/components/ui/button.tsx`
- `webui/src/App.tsx`
- `webui/src/components/delivery/delivery-queue.tsx`
- `webui/src/components/layout/mode-toggle.tsx`
- `webui/src/components/metrics/data-table.tsx`
- `webui/src/components/metrics/language-toggle.tsx`
- `webui/src/components/metrics/query-filters.tsx`
- `webui/src/components/overview/reset-credit-action.tsx`
- `webui/src/components/requests/request-detail.tsx`
- `webui/src/components/requests/requests-table.tsx`
- `webui/src/components/settings/account-settings-management.tsx`
- `webui/src/components/settings/relay-model-copy.tsx`
- `webui/src/components/settings/relay-provider-models.tsx`
- `webui/src/components/settings/settings-controls.tsx`
- `webui/src/components/traffic/traffic-content.tsx`
- `webui/src/components/ui/alert-dialog.tsx`
- `webui/src/components/ui/dialog.tsx`
- `webui/src/components/ui/sheet.tsx`
- `webui/src/components/ui/sidebar.tsx`
- `webui/src/pages/console-page.tsx`
- `webui/src/pages/relay-page.tsx`
- `webui/src/pages/thread-detail-page.tsx`
- `webui/src/pages/traffic-page.tsx`

使用真实 Base Button；链接显式 nativeButton={false}，保留尺寸与样式标识。

已检查本组件及受影响业务文件，无 radix-ui、@radix-ui 或 asChild 残留。

## Left alone

保留现有主题、业务接口与服务端实现；Recharts 等独立库不替换。共享 cn 导入已统一。

## Behavior changes

业务状态及提交语义保持，底层 DOM 和数据属性采用 Base UI。

## Verify by hand

在中文和英文下打开相关页面；通过 Tab 与 Enter 操作，检查禁用状态与窄屏布局。弹层检查 Esc、外部点击和关闭后焦点；选择框检查标签与键盘选择；侧栏检查折叠与移动端关闭。
