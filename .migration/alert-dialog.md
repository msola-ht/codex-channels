# alert-dialog

2026-10-02 · golden pair via CLI / merge · 已迁移。

## Changed

- `webui/src/components/ui/alert-dialog.tsx`
- `webui/src/components/delivery/delivery-queue.tsx`
- `webui/src/components/settings/settings-controls.tsx`
- `webui/src/pages/relay-page.tsx`

保留项目弹窗宽度和布局；业务取消按钮使用 initialFocus，执行中取消关闭事件。

已检查本组件及受影响业务文件，无 radix-ui、@radix-ui 或 asChild 残留。

## Left alone

保留现有主题、业务接口与服务端实现；Recharts 等独立库不替换。共享 cn 导入已统一。

## Behavior changes

官方 Action 是普通按钮，关闭由已有业务确认结果控制；显式 initialFocus 保留取消优先。

## Verify by hand

在中文和英文下打开相关页面；通过 Tab 与 Enter 操作，检查禁用状态与窄屏布局。弹层检查 Esc、外部点击和关闭后焦点；选择框检查标签与键盘选择；侧栏检查折叠与移动端关闭。
