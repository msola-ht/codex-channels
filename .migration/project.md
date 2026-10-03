# WebUI Base UI migration

2026-10-02 · golden pair via CLI / merge · 全项目迁移完成。

## Changed

- `webui/components.json`：`radix-nova` 改为 `base-nova`。
- `webui/package.json`、`webui/package-lock.json`：采用 `@base-ui/react` 与官方 `cn`；移除直接依赖 `radix-ui`、`clsx`、`tailwind-merge`。其他工具的传递依赖不强行移除。
- `webui/src/components/ui/`：官方 CLI 安装 Base 组件，恢复尺寸、弹窗布局、侧栏上下文、本地化与提示颜色定制。逐组件记录见本目录对应文件。
- 业务组件：`render` 组合、Select 标签映射、ToggleGroup 数组值、Checkbox 半选、菜单点击回调、弹窗关闭阻止及焦点管理迁移到 Base API。
- `webui/src/components/ui/toast.tsx`、`toast-manager.ts`、`webui/src/App.tsx`、`relay-provider-models.tsx`：统一通知容器，目录更新成功通知默认 3 秒关闭；失败信息保留在页面。
- `tests/webui-relay-page.test.ts`、`tests/webui-tables.test.ts`、`tests/webui-settings-navigation.test.ts`：更新迁移后的 DOM/API 合同，并覆盖成功通知、失败保留、选择标签与可访问说明。
- `webui/README.md`、`docs/webui.md`：更新 UI 维护约定与通知行为。
- `.agents/skills/shadcn/`、`.agents/skills/migrate-radix-to-base/`、`skills-lock.json`：更新官方 shadcn 技能并安装迁移技能。

## Left alone

迁移保留已有的 Relay 链路修复。迁移未修改主题变量、转发协议、用户配置或运行中的服务。
Recharts、React Activity Calendar 等非 Radix 库保留，仅共享类名工具改用 cn。

## Behavior changes

- Base 复选菜单默认保持打开；列显隐可连续勾选，普通操作菜单仍执行后关闭。
- Base Tooltip 是视觉提示，不自动生成读屏描述。表头、Token 明细与错误摘要由业务显式提供 `aria-description`；完整文本及图标按钮名称保持可访问。
- AlertDialog Action 不自动关闭。确认结果仍由业务状态控制；初始焦点显式落到取消，忙碌期间阻止关闭。
- Base Progress 增加 Track；使用百分比宽度与 `data-progressing`，数值含义不变。

## Verify by hand

已在隔离的 Chromium 页面验证桌面 1440px 和窄屏 390px：选择标签、键盘选择及菜单动作、单选切换、复选菜单保持、弹窗外部点击保护、Esc 与焦点返回、忙碌确认保护、悬浮说明、3 秒通知、目录更新通知、移动侧栏，以及英文模型目录关闭后的焦点返回。使用模拟 API，未访问当前服务数据。

开发验证：WebUI build、WebUI lint、根 check/lint、i18n:check、docs:check；8 个相关 WebUI 测试文件累计 83 项通过。提交时由 Git 钩子运行完整 `verify:commit` 门禁。

技能校验：迁移技能通过 quick_validate；官方 shadcn 技能的 `user-invocable` 元数据不在本地校验器白名单中，该字段更新前已存在，保留官方原件，未为通过校验修改源技能。

源码与直接依赖扫描：0 个 UI wrapper 保留 Radix，无 `asChild` 或旧弹层回调兼容接口。
