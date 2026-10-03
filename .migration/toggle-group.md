# toggle-group

2026-10-02 · golden pair via CLI / merge · 已迁移。

## Changed

- `webui/src/components/ui/toggle-group.tsx`
- `webui/src/components/delivery/delivery-queue.tsx`
- `webui/src/pages/relay-page.tsx`

单选值改为数组并忽略空选择，方向传到原语。

已检查本组件及受影响业务文件，无 radix-ui、@radix-ui 或 asChild 残留。

## Left alone

保留现有主题、业务接口与服务端实现；Recharts 等独立库不替换。共享 cn 导入已统一。

## Behavior changes

业务状态及提交语义保持，底层 DOM 和数据属性采用 Base UI。

## Verify by hand

在中文和英文下打开相关页面；通过 Tab 与 Enter 操作，检查禁用状态与窄屏布局。弹层检查 Esc、外部点击和关闭后焦点；选择框检查标签与键盘选择；侧栏检查折叠与移动端关闭。
