# WebUI 前端审查计划与记录

本次审查覆盖 `webui/` 的 UI 组件规范、模块化与解耦、状态管理、重复实现和验证覆盖，目标是形成有源码依据的改进顺序，并判断是否值得引入状态管理库。审查完成一项即在本文记录一项，最后给出整体结论。全面审查后，按用户追加的“全链路关联审查修复”要求实施整改，关联调用方、错误恢复、测试及文档；审查记录保留原始发现，整改结果单独记录。

审查日期：2026 年 10 月 4 日。源码基线：`a1545fa4`；开始审查时工作区干净。

当前状态：全面源码审查及首轮 21 项关联整改已完成。基线 `webui/src` 的 161 个文件已逐文件阅读并按 12 个模块记录，工程配置与跨目录依赖已核对；新增模块也完成集成复核。第二轮复核完整未提交差异，补充发现并修复 R1。首轮通过 231 项关联测试，第二轮真实浏览器合同扩展至 16 项并全部通过；分轮验证证据见文末。此完成状态不代表全浏览器视觉、读屏或性能验收完成。

## 范围与方法

- 依据项目规则、`webui/README.md`、实际调用链及现有测试；shadcn 技能作为组件组合参考，区分项目约定、功能缺陷与可选风格建议。
- 检查页面到领域组件、Hook、API 客户端与共享类型的依赖；后端仅作为前端接口边界参考，不扩展为协议或后端全面审计。
- 每项发现记录证据、影响、优先级、改进方案与验收方式。P1 表示优先修复的功能风险，P2 表示可维护性或局部交互问题，P3 表示一致性优化。
- 静态代码审查不能替代浏览器交互、可访问性测试或性能测量；尚未验证的推断明确标注。

## 审查顺序与进度

| 项目 | 检查内容 | 状态 |
| --- | --- | --- |
| 1 基线与分层 | 目录职责、依赖、路由、已有公共能力 | 已完成 |
| 2 UI 组件规范 | 基础组件、领域组合、表单、弹层、语义样式、可访问性 | 已完成 |
| 3 模块与重复 | 页面职责、跨域依赖、重复业务逻辑、抽象边界 | 已完成 |
| 4 状态管理 | 本地状态、URL、Context、请求并发、SSE、草稿与确认 | 已完成 |
| 5 验证与总结 | 测试证据、状态库决策、整改顺序和验收 | 已完成 |

## 全面审查覆盖表

每个模块须逐文件阅读实现，再沿调用方检查输入、输出、状态所有权、异步取消、失败路径、UI 语义和测试。基础组件也纳入阅读，不因来自生成器直接视为通过。文件覆盖清单与模块结论随完成逐项追加。

| 模块 | 范围 | 状态 |
| --- | --- | --- |
| A 工程与应用入口 | 构建配置、main、App、路由与导航 | 已完成 |
| B 请求与事件基础 | API、useApi、SSE、轮询、范围刷新、导出 | 已完成 |
| C 查询与展示基础 | URL 参数、时间、格式化、令牌、语言、类型 | 已完成 |
| D 基础 UI 与布局 | components/ui、layout、全局样式、移动端 Hook | 已完成 |
| E 公共指标组件 | components/metrics、表格、筛选、状态与提示 | 已完成 |
| F 概览与账户 | console、overview、账户快照及图表 | 已完成 |
| G 请求错误与会话 | requests、errors、threads、子代理及其 Hook | 已完成 |
| H 调用详情 | traffic 页面、组件、查询与状态 | 已完成 |
| I 日志与投递 | logs、delivery 页面、组件及 Hook | 已完成 |
| J 设置状态与确认 | 管理 Hook、版本化确认、草稿和任务 | 已完成 |
| K 设置领域与页面 | 设置、模型、渠道页面和领域表单 | 已完成 |
| L Relay | Key 管理、模型目录、服务与实时队列 | 已完成 |
| M 综合复核与验证 | 完整文件覆盖核对、跨模块调用、测试与最终决策 | 已完成 |

## 逐模块审查记录

本节路径均相对 `webui/`。完整阅读记录不等于所有动态交互均已验收；每项分别说明证据强度。

### A 工程与应用入口

完整阅读：`src/App.tsx`、`src/main.tsx`、`src/lib/navigation.ts`、`package.json`、`vite.config.ts`、`tsconfig.json`、`tsconfig.app.json`、`tsconfig.node.json`、`components.json`、`index.html`、`.oxlintrc.json`、`.gitignore`、`.npmignore`；检查 favicon SVG 的静态资源属性。依赖锁文件按实际版本与构建解析核对，不把生成的依赖树逐行当作业务代码审计。

链路：启动清除 URL 中令牌 → Theme/Language/Auth Provider → HashRouter/Layout → 服务端时间就绪 → 懒加载页面。导航数据集中维护，设置页用 key 区分需要隔离的表单；鉴权失败由 API 通知 AuthGate。Vite 开发服务仅绑定回环地址，代理为管理接口设置精确 Origin；这不是生产鉴权实现。

**A1，P2，隔离复现：畸形会话路径导致渲染异常。** `App.tsx:90` 直接 `decodeURIComponent(threadPath)`。真实 `BreadcrumbTrail` 经 Vite SSR 加载后，`/threads/parent%2Fthread` 正常显示，而 `/threads/%` 抛出 `URIError: URI malformed`。应用没有 ErrorBoundary，错误可能使整个应用渲染中断，而非返回可恢复的非法地址提示。建议在路径输入边界处理解码失败并提供返回入口，另为懒加载/页面渲染失败提供局部恢复边界。SSR 已确认抛错，浏览器白屏外观未实测；补畸形编码、合法编码与懒加载失败恢复验收。

其他结论：未知路由没有兜底页面，可列 P3 导航恢复体验改进；当前页面懒加载真实产出独立 chunk。不要仅凭 bundle 名称推断某 Hook 体积。配置没有显式 `strict`，但通过已安装 TypeScript 6 的配置 API 验证有效 `strictNullChecks=true`，排除“前端未开启严格空值检查”的误报。未发现需要新路由框架或目录级架构迁移的依据。

### B 请求与事件基础

完整阅读：`src/lib/api.ts`、`api-polling.ts`、`range-refresh.ts`；`src/hooks/use-api.ts`、`use-queue-events.ts`、`use-range-refresh.ts`、`use-metrics-export.ts`。所有 API 入口均检查 HTTP 方法、路径参数编码、确认参数传递和取消信号；业务响应类型来自共享定义，未建议在可信同源接口内部重复建立第二套协议解析器。

链路：requestJson 集中认证、30 秒超时与结构化错误；useApi 负责取消旧请求、拒绝迟到交付、替换快照和成功读取时间；通知层区分 revision 的 attempted/confirmed，读取期间的新通知不会被旧结果一起确认，重试有上限与限流冷却。隐藏/离线停止订阅，历史分页通过 enabled 阻止自动替换，但保留通知版本以便回到首页补查。写操作没有被通用 GET 重试策略自动重发。

S1 的 SSE 大块误拒绝成立。其余已核对的边界未确认新增独立缺陷：读取后再计时的轮询不主动中断进行中的请求；范围刷新考虑滚动窗口、服务端跨日和 DST，离线/后台只留一次恢复读取；导出按点击时查询生成，卸载取消，结束释放 Blob URL，错误只保存结构化代码。导出中的查询变化不自动改成另一份数据，不能当作错误结果串线。

测试证据：`webui-api-polling`、`webui-delivery-events`、`webui-range-refresh` 覆盖大部分调度、取消和版本状态；真实 React 挂载合同仍不足，见 V1。公共 Hook 不应再被一层没有额外业务约束的通用框架包裹。

### C 查询与展示基础

完整阅读：`src/hooks/use-metrics-query.ts`、`use-server-time.ts`、`language-context.ts`、`language-provider.tsx`、`use-translation.ts`；`src/lib/metrics-query.ts`、`server-time.ts`、`format.ts`、`token-storage.ts`、`query-token.ts`、`types.ts`、`i18n/messages.ts`、`i18n/translate.ts`；另读 `i18n-glossary.json`。字典 1549 行、27 个命名空间全部核对，结构检查覆盖 957 个中文源键及英文对应占位符。

查询以 URL 为事实来源，草稿与已应用值分开；链接构建清理分页/排序，保留明确关联条件；提供商选项跟随成功读取版本、30 秒节流而非新增订阅。服务端时区在页面启动前初始化，时钟隐藏时停表、恢复时合并校准。紧凑数字 K/M/B 与统一时间格式是已有项目口径，不能按浏览器语言擅自改变。语言保存在 Context，持久化失败不阻止当前页面切换。

**C1，P2，隔离复现：令牌存储失败被当作登录成功。** `token-storage.ts:19` 的 setToken 在 localStorage 与 sessionStorage 都失败时静默返回，注释称仅本次会话保留，但不存在内存保存。使用两个均抛错的模拟 Storage，真实模块 `setToken()` 不抛错而 `getToken()` 为 null；`auth-gate.tsx:80` 随后无条件 reload，成功验证也会丢失令牌、再次返回登录。建议让写入结果可观测，未成功保存时保留当前输入并显示本地化失败，不循环刷新；是否提供内存模式须另行明确支持语义，不能只补一个会在 reload 后丢失的变量。URL 自动登录也应沿用可观测的失败结果，仍须先清除 URL 中的敏感参数。验收覆盖正常保存、session 回退、两者都不可用。

**C2，P2，风险文案语义不一致：** 中文 `relay.cleanupFailed` 与 `relay.auditFailed` 在约 187 行要求“不要重复签发”，英文约 954 行却写成 “do not issue another key automatically”，额外限定为自动操作。`relay-page.tsx:171` 在修改已保存、锁清理或审计失败时实际显示这些提示。建议移除缩窄含义的限定，保留“已保存、先保存新 Key、核对故障、不要重复本次签发”的信息；不改变一次性确认或操作状态。补英文失败结果呈现合同，键和占位符对齐不能发现这类语义错误。

**C3，P3，隔离复现：非法 URL 范围进入翻译键。** `use-metrics-query.ts:39` 将 URL range 直接断言为类型，筛选器随后拼接 `ranges.${range}`。真实 QueryFilters 的 SSR 在 range=bogus 时输出 `aria-label="Time range: ranges.bogus"`。后端仍拒绝非法参数，不是越权；建议入口识别非法范围并显示明确的本地化错误，不默默改成 all，也不把内部键名呈现给用户。

其余动态键已检查来源：导航、通知、日志级别、投递类型、Relay 操作/结果和重置券结果来自本地映射、有限枚举或共享服务端合同；未发现应改为一套重复浏览器协议解析器的理由。未知内部查询错误映射通用文案，日志、用户内容、账户原值与延期设置文案按文档保留。测试入口为 `webui-query-token`、`webui-i18n`、`webui-i18n-tool`、`webui-range-refresh`、`webui-api-polling`。

### D 基础 UI 与布局

完整阅读 `src/components/ui/` 全部 33 文件：`alert-dialog.tsx`、`alert.tsx`、`avatar.tsx`、`badge.tsx`、`breadcrumb.tsx`、`button.tsx`、`card.tsx`、`chart.tsx`、`checkbox.tsx`、`collapsible.tsx`、`dialog.tsx`、`dropdown-menu.tsx`、`empty.tsx`、`field.tsx`、`input-group.tsx`、`input.tsx`、`label.tsx`、`progress.tsx`、`select.tsx`、`separator.tsx`、`sheet.tsx`、`sidebar-context.ts`、`sidebar.tsx`、`skeleton.tsx`、`spinner.tsx`、`table.tsx`、`tabs.tsx`、`toast-manager.ts`、`toast.tsx`、`toggle-group.tsx`、`toggle-variants.ts`、`toggle.tsx`、`tooltip.tsx`。

另完整阅读 `src/components/layout/app-sidebar.tsx`、`auth-gate.tsx`、`mode-toggle.tsx`、`src/index.css`、`src/hooks/use-mobile.ts`、`src/lib/utils.ts`。逐项核对 ref/render/props 透传、受控与非受控状态、disabled/invalid、标题及关闭标签、焦点/关闭事件、ARIA、移动断点、主题与动画。

**D1，P3，已隔离复现：Tabs orientation 未透传。** `tabs.tsx:7` 解构方向，仅设置 `data-orientation`，未传给 Base UI Root。SSR 对 `vertical` 的真实组合输出显示 Root 为 vertical、TabList 仍为 horizontal，安装版本源码也确认键盘处理仍使用横向。修复应透传属性并补横纵合同。当前唯一业务调用日志页使用横向，不应声称该页已有纵向交互故障。依据：[官方 Tabs API](https://base-ui.com/react/components/tabs)及已安装 Base UI 1.8.0 源码。

**D2，P2，静态确认：登录把服务故障误报成令牌错误。** `auth-gate.tsx:76` 将所有非 2xx 统一设为 `auth.invalidToken`，包括 500/503。应区分鉴权失败、服务失败、网络与超时，并与 S2 一起补测试；仍不向用户暴露未知内部异常。登录输入框 Enter 未提交属于较低优先级体验改进。

排除的疑点：ToastAction 无内容时 Base UI 返回 null，不产生空按钮；现有 Sheet 调用对可见关闭按钮提供本地化名称；基础生成组件的 dark/z-index 是样式实现，不按业务组合规则一概判错；ChartStyle 当前 CSS 配置来自源码定义，没有用户 HTML 输入路径；侧栏 cookie 读取失败有默认值、原生链接语义保留。真实门户、焦点捕获/恢复、Escape、移动断点与嵌套弹层未浏览器实测。

### E 公共指标组件

完整阅读 `src/components/metrics/` 全部 13 文件：`data-table.tsx`、`error-banner.tsx`、`language-toggle.tsx`、`page-skeleton.tsx`、`provider-badge.tsx`、`query-filters.tsx`、`query-summary.tsx`、`range-selector.tsx`、`refresh-status.tsx`、`service-tier.tsx`、`stat-card.tsx`、`status-badge.tsx`、`token-tooltip.tsx`。

核对了 client/server/none 三种表格模式、排序分页、筛选、列持久偏好、空态与失败、查询草稿与已应用 URL、文本溢出提示与 ResizeObserver 清理、读屏标签及翻译。UI1 的唯一详情列可隐藏问题和 UI3 的提示重复成立。

**E1，P3，小范围规范重复：** `service-tier.tsx:20` 的 FastBadge 手写 `h-4 px-1.5 py-0 text-[10px]`，与已有 Badge `size="sm"` 相同。直接使用组件尺寸参数即可，无需新组件。其余排除：RefreshStatus 对客户端读取时间只加服务端固定偏移；QueryFilters 通过 Hook 请求提供商符合分层；筛选范围候选少于协议类型并不自动构成功能缺失；骨架可由父层承担加载语义。真实文字溢出、原生日期验证、筛选关闭后的焦点需要交互验收。

### F 概览与账户

完整阅读：`src/pages/console-page.tsx`；`src/components/overview/` 的 `account-refresh-feedback.tsx`、`account-subscription-notice.tsx`、`overview-sections.tsx`、`reset-credit-action.tsx`、`usage-charts.tsx`；`src/hooks/use-dashboard.ts`、`use-official-account-sources.ts`；`src/lib/account-refresh-state.ts`、`overview-state.ts`、`trend.ts`。

链路：概览整批读取与查询归属隔离；账户从已保存快照读取，手动动作才查询上游，按观测时间合并，整表读取决定成员增删。并发限制为 4，手动失败记录有 256 项边界。趋势按服务端日历标签处理 DST。重置券跨层和取消问题沿用 M2，不能解释为自动重复消费。

**F1，P2，静态确定：账户配置失败后的重试按钮必定禁用。** `account-subscription-notice.tsx:21` 的 `disabled` 包含 `management.error !== null`，而约 43 行仅在该 error 存在时显示的“重新读取账户配置”按钮又使用 `disabled={disabled || management.loading}`。用户无法通过这个恢复入口重试；同一禁用状态还影响账户刷新。建议区分“允许只读重试”和“允许配置变更”的条件，保留未取得可靠快照时禁止删除的保护。补错误 → 可重试 → 成功恢复测试。

**F2，P3，静态确定的重复请求：** 每张无订阅账户卡均调用 `useAccountSettingsManagement()`，从而独立请求同一整份账户配置。N 张卡会发起 N 次相同 GET。建议提升读取至账户区块并共享快照，或在删除入口按需读取；确认状态仍按账户/操作隔离。尚未测量实际账户数量或延迟，不能据此认定严重性能瓶颈或必须引入缓存库。

相关证据：`webui-overview-state`、`webui-account-refresh-state`、`webui-api-polling`、`webui-reset-credits`、`webui-settings-presentation`、`webui-i18n`、`webui-tables` 测试。账户提示既有展示测试覆盖 pending/loading/saving，未覆盖 F1 的 error 重试分支。本次另以真实组件及失败 Hook 快照做 SSR，确认读取错误时删除按钮和重试按钮均为 disabled，F1 已取得隔离执行证据。

### G 请求错误与会话

完整阅读：`src/pages/requests-page.tsx`、`errors-page.tsx`、`threads-page.tsx`、`thread-detail-page.tsx`、`thread-subagents-page.tsx`；`src/components/requests/errors-table.tsx`、`relay-request-status.tsx`、`request-detail.tsx`、`requests-table.tsx`；`src/components/threads/thread-run-summary.tsx`、`thread-subagents.tsx`、`thread-table.tsx`、`turn-table.tsx`；`src/hooks/use-requests.ts`、`use-errors.ts`、`use-threads.ts`、`use-thread-detail.ts`、`use-thread-subagents.ts`。

链路：URL → 指标 Hook → 通知触发读取；历史页冻结；详情汇总与轮次同批发布；子代理独立服务端分页。请求抽屉按相同 ID 跟随当前列表更新，移出当前页后保留最后快照是既有合同；详情不另行抓取调用报文。子代理导航清理请求筛选并明确 `range=all`。

未确认除 UI1、UI3、M1 外新增功能缺陷。特别复核了查询变化旧数据保护与失败隐藏结果，不将已有测试要求的旧 data 保留认定为错误。P3 可选整理：`turn-table.tsx:197` 未提供 `getRowId`，可按 turnId 明确行身份；当前行只用于展示，尚无错误状态复用证据，不单列优先修复。验证入口：`webui-tables`、`webui-api-polling`、`webui-i18n`。

### H 调用详情

完整阅读：`src/pages/traffic-page.tsx`；`src/components/traffic/traffic-cleanup-controls.tsx`、`traffic-content.tsx`、`traffic-detail.tsx`、`traffic-model.tsx`、`traffic-request-content.tsx`、`traffic-table.tsx`；`src/hooks/use-traffic.ts`、`use-traffic-query.ts`；`src/lib/traffic-state.ts`。

链路：URL 分离列表 label/session 与详情 exchangeLabel/exchangeSession → 只激活当前列表或详情的一条订阅 → 按 label/session/id 锁定精确对象。终态补读 trace，事件数量变化后补齐摘要，手动刷新清理摘要缓存；翻 trace 页保留同一调用摘要但隐藏旧 trace 并禁用分页。清理操作经任务预览确认；正文按文本渲染，折叠时不挂载大段内容。

**H1，P3，静态状态缺口：** `traffic-content.tsx:20` 的 `copyState` 独立于 `text`，正文自动补齐后仍可能显示上一版本的“已复制”。建议让复制反馈关联已复制内容身份，内容变化即恢复可复制状态；无需将其提升到全局 Store。尚未浏览器复现，验收应复制 A → 正文更新 B → 反馈重置 → 再次复制 B。

排除：`requestsReturnTo` 受 `/requests` 路径限制；调用清理后不重新显示旧对象；展示代码不执行正文 HTML。相关测试：`webui-traffic-state`、`webui-traffic-events`、`webui-server-traffic`、`webui-tables`、`webui-i18n`。UI1 的可隐藏键盘入口仍影响此模块。

### I 日志与投递

完整阅读：`src/pages/logs-page.tsx`、`delivery-page.tsx`；`src/components/service-logs/service-logs.tsx`、`log-results.tsx`；`src/components/delivery/delivery-queue.tsx`；`src/hooks/use-service-logs.ts`、`use-delivery-queue.ts`；`src/lib/service-logs.ts`。补查服务端日志路由的输入清洗合同。

日志链路：target/lines 查询隔离 → 可见页面定时读取 → 解析 → 筛选 → 读者滚动期间冻结快照。旧查询取消，详情跟随保留快照。`parseJournalLine` 的 JSON.parse 消费服务端已解析并重新序列化的白名单字段，不能把内部函数不重复验证直接定为生产解析漏洞。stderr 不根据关键词猜日志级别。

投递链路：筛选和游标重建查询 → SSE 快照 → 按 id/revision 缓存正文 → 批量选择 → 预览确认 → 回读。选择只能作用于当前 eligible 且 revision 匹配记录，旧选择不能作用于新版本；弹窗期间阻止筛选/翻页及自动快照替换。正文缓存移除页外键，错误读取有有限重试，写响应丢失显示不确定状态而非自动重试。

未确认这两个领域新增独立功能缺陷；共同依赖的 SSE 大块问题见 S1、基础 Tabs 接口问题见 D 模块。测试入口为 `webui-logs`、`webui-logs-page`、`webui-delivery-page`、`webui-delivery-events`、`webui-delivery-management`。

### J 设置状态与确认

完整阅读：`src/hooks/use-management-confirmed-mutation.ts`、`use-versioned-settings-management.ts`、`use-settings-draft.ts`、`use-management-tasks.ts`、`use-settings-management.ts`、`use-codex-settings-management.ts`、`use-account-settings-management.ts`、`use-provider-settings-management.ts`；`src/lib/settings-management.ts`、`settings-state.ts`；`src/components/settings/settings-controls.tsx`、`settings-feedback.tsx`、`settings-page-frame.tsx`、`gateway-settings-section.tsx`、`management-task-controls.tsx`。

完整检查两类确认状态机的 preview/apply/cancel/refresh/unmount：同步 operation Ref 防并行、卸载中止、stale-revision 回读、令牌原样提交均已有实现。tasks 使用独立取消 Map、通知快照与终态资源刷新；draft 只保存编辑差异。确认框初始焦点在取消按钮，保存时关闭受阻，危险操作按钮语义明确。

不建议强行合并两种确认 Hook：版本化设置还负责 revision、before、activation，一次性管理确认负责不同的 token 合同。相似代码外观不足以证明可合并。现有纯状态及展示测试覆盖草稿保留、字段确认和按钮限制；真实门户焦点与 StrictMode 生命周期的证据边界仍见 V1。

### K 设置领域与页面

完整阅读：`src/pages/settings-page.tsx`、`channels-page.tsx`、`model-management-page.tsx`；`src/components/settings/app-server-settings-card.tsx`、`gateway-settings-card.tsx`、`workspace-settings-card.tsx`、`webui-data-settings-card.tsx`、`tool-access-settings.tsx`、`provider-settings-management.tsx`、`account-settings-management.tsx`、`account-id-field.tsx`、`provider-channel-status.tsx`、`cli-command-row.tsx`、`settings-cli-commands.tsx`。共用控制组件与 Hook 已在 J 阅读。

页面按 section 组合控制器，Gateway/Codex 分别使用版本化状态，Provider/Account 按预览令牌提交，onChanged 负责相关快照回读，数据与服务操作等待任务终态。后台刷新按字段保留草稿，前端权限继承显示不替代服务端验证。UI2 的字段错误关联缺口成立。

**K1，P3，重复组件：** `provider-channel-status.tsx:81` 的 `StatusRow` 与 `settings-controls.tsx:78` 导出的 `SettingsRow` 参数和响应式展示结构相同。直接复用已有组件即可，避免新抽象。Provider 编辑器可按提供商、默认值、窗口设置三个领域渐进拆分，但不能仅因文件较长判为功能缺陷。

设置页大量中文属于 [WebUI 指南](webui.md) 已声明的延期翻译范围，列为既有覆盖缺口，不伪装成此次引入的回归。测试入口为 `webui-settings-state`、`webui-settings-presentation`、`webui-settings-navigation`、`webui-model-management`；动态焦点和字段错误需补专门验收。

### L Relay

完整阅读：`src/pages/relay-page.tsx`、`relay-queue-page.tsx`；`src/hooks/use-relay-management.ts`、`use-relay-queue.ts`、`use-relay-service-management.ts`；`src/components/settings/relay-service-management.tsx`、`relay-provider-models.tsx`、`relay-key-models.tsx`、`relay-model-copy.tsx`、`managed-services.tsx`。

**L1，P2，分层改进：** `relay-provider-models.tsx:23` 起直接编排 `updateRelayCatalog`，同时管理单飞、取消、缺失时自动尝试、下载结果、审计失败通知和刷新。建议将操作下沉至窄范围目录 Hook，组件消费控制器。现实现已有同步互斥和卸载取消，因此这是职责问题，不是确认的请求泄漏；抽取必须保留这些合同。

**L2，P2，页面职责改进：** `relay-page.tsx:33` 至 97 行同时维护草稿修订、模型能力、关闭推理策略删选、随机标识、mutation payload 和保存结果，之后再组合 Key 表格及三类弹窗。建议分离 Key 编辑领域 Hook 与 Key 表格、编辑、确认、一次性结果组件。依据是业务规则混入页面而非文件行数；不得引入第二套确认状态或缓存完整密钥。

排除：队列 unknown 被转成受控失败，不保留旧成功数据冒充当前运行态，停止与空队列分别显示；服务管理共享手动、页面恢复和任务终态刷新，其他管理任务锁与 scope 筛选有实现；模型剪贴板按精确调用 ID 提供失败替代。测试入口 `webui-relay-page`、`webui-delivery-events`、`webui-relay-management`，分别覆盖展示、通知状态、隔离 API/IPC 的修订、Origin、一次性确认及授权边界。

### M 跨模块核对

将逐模块清单与 `rg --files webui/src` 对账：共 161 个源码文件，A 3、B 7、C 13、D 39、E 13、F 11、G 18、H 10、I 8、J 15、K 14、L 10，未分配或未完成文件为 0。另检查工程配置、静态入口、术语表和实际依赖版本；node_modules、dist 与生成依赖锁不作为自有业务源码逐行审计。

使用 TypeScript AST 解析本地运行时 import/export 并核对相对路径，未发现 `webui/src` 内运行时静态依赖环。展示组件直接引入 API 的入口只有 AuthGate、ResetCreditAction、RelayProviderModels：前者是文档明确允许的候选令牌验证例外，后两者分别列 M2、L1。类型依赖不计作运行时依赖，动态页面 import 另按 App 路由逐项检查。

源码目录外的运行时复用也已补读：`runtime/managed-provider-account-options.mjs`、`runtime/model-name-comparison.mjs`、`src/surfaces/elapsed-duration.ts` 均是纯函数/常量，没有引入服务管理、平台 SDK 或账户访问。共享类型经 `scripts/webui-api` 转出，没有前端响应镜像。它们的物理位置存在层间联系，但不能误报为浏览器启动后端服务。

跨模块重点复核：旧查询结果的 UI 防护、账户成员与观测时间合并、确认 token 和 revision、任务终态刷新、目录能力变化与 Key 草稿、日志冻结、投递 id/revision、Traffic label/session/id、语言切换与已保存结果。未确认需要整体重建状态体系或添加通用框架的证据；已确认的读取重复和边界问题仍须按下方计划整改。

## 基线与分层

前端使用 React 19、TypeScript、Vite、React Router、Base UI/shadcn、TanStack Table。当前依赖未包含 Redux、Zustand 或 TanStack Query。`App.tsx` 进行页面懒加载，`pages/` 组合页面，`components/` 按领域组织，`hooks/` 管理读取和操作状态，`lib/` 集中 API、格式化与纯状态逻辑。

现有工程已提供 `useApi`、统一刷新调度、队列事件订阅、版本化管理确认与设置草稿等公共能力；共享 API 类型由 `lib/types.ts` 转出，未另建前端响应镜像。审查应优先验证这些机制是否存在边界遗漏，而不是重新建立一套全局状态框架。

证据入口：[前端模块说明](../webui/README.md)、[依赖声明](../webui/package.json)、[应用组合](../webui/src/App.tsx)、[共享类型](../webui/src/lib/types.ts)。

## UI 组件规范

### UI1 隐藏详情入口列后缺少键盘替代路径

**P2，已确认代码路径。** [请求表](../webui/src/components/requests/requests-table.tsx) 的 `traffic` 列（约 288 行）与 [调用表](../webui/src/components/traffic/traffic-table.tsx) 的 `time` 列（约 26 行）提供原生详情按钮，但这些列可隐藏。[DataTable](../webui/src/components/metrics/data-table.tsx) 约 398 行允许隐藏列，约 488 行的行操作仅绑定 `onClick`。隐藏对应列后，鼠标仍可打开详情，键盘用户失去该行的详情入口。

建议将详情操作列设为不可隐藏，或保留另一个不可隐藏的原生按钮/链接。继续保留表格语义，不把包含链接和按钮的整行强行改成按钮。验收应覆盖隐藏列后使用 Tab 与 Enter 打开详情、关闭弹层后恢复焦点；当前仅静态确认，尚未浏览器实测。

### UI2 字段校验错误缺少输入关联

**P2，静态确认。** [ToolAccessSettings](../webui/src/components/settings/tool-access-settings.tsx) 约 44 行处理 JSON 和数字校验错误，但约 57 行起的控件没有相应 `aria-invalid`、`aria-describedby` 和 Field 无效状态。[AppServerSettingsCard](../webui/src/components/settings/app-server-settings-card.tsx) 约 49 行的上下文窗口、压缩百分比校验也仅在约 133 行统一显示 `localError`。

公共 Alert 已有 `role="alert"`，因此不能说错误完全不播报；缺口是用户返回字段时无法从字段自身识别无效状态及对应错误。建议记录出错字段，复用 [AccountIdField](../webui/src/components/settings/account-id-field.tsx) 与 AuthGate 已有的字段无效状态和错误描述关联模式，不建立新表单框架。验收覆盖两个字段分别非法、错误清除、错误描述关联和键盘修改。

### UI3 Token 提示重复实现

**P3，可维护性。** [请求表](../webui/src/components/requests/requests-table.tsx) 约 243 行重复了 [OutputTokenTooltip](../webui/src/components/metrics/token-tooltip.tsx) 约 50 行的计算、翻译和提示结构，焦点样式已有差异。建议先复用现有输出提示组件。输入提示也有重复，但请求表采用服务端 `cacheHitRate`，公共组件自行计算，不能直接替换而改变统计口径。复用时保持空值、零值、推理 Token 与服务端命中率语义，并沿用表格测试。

### 组件规范整体评价

基础 UI 与领域组合的分层基本成立，公共 DataTable 已有表格名称、`aria-sort`、`aria-busy`、加载期 `inert` 和语义分页按钮；Select、Field、Badge、Tooltip 等已有集中组件。确认弹窗已有取消按钮初始焦点与保存期间关闭防护。这些应保留，无证据支持整体重建组件体系。

可随相关修改处理的小项：AuthGate 没有 `<form onSubmit>`，在输入框按 Enter 不提交，但可 Tab 到按钮提交，属于体验优化；概览少量 `space-y-*` 与 shadcn 技能的 gap 偏好不一致，不应升级成独立架构整改。未发现需要仅为风格统一而全面替换现有组件的理由。

## 模块边界与重复实现

### M1 指标快照 Hook 重复且查询归属合同不统一

**P2，可维护性。** [useRequests](../webui/src/hooks/use-requests.ts)、[useErrors](../webui/src/hooks/use-errors.ts)、[useThreads](../webui/src/hooks/use-threads.ts) 约 8 至 20 行重复查询标识、SSE 订阅、历史分页暂停、范围刷新及状态投影。[useThreadDetail](../webui/src/hooks/use-thread-detail.ts) 也重复其中的编排。

这些 Hook 在查询变化时仍返回旧 `data`，只通过 `loading` 与 `lastUpdatedAt` 标记归属；`useDashboard`、`useThreadSubagents` 等则直接隔离旧查询数据。已复核当前页面防护：`QuerySummary` 隐藏旧汇总，`DataTable` 在加载期间显示骨架并设置 `inert`，错误时页面不渲染结果。因此本项不是已证实的旧数据误展示或旧分页误操作，而是新消费方必须了解额外合同的维护负担。

建议先抽取一个限定于指标快照的公共 Hook，统一状态投影、历史暂停与通知；领域 Hook 保留请求参数与业务接口，会话详情保留双请求成功后原子交付。第一步保持现有返回语义：[表格测试](../tests/webui-tables.test.ts) 约 1051 行明确要求查询变化时保留旧 `data` 并标记 `loading`，不能把改变这一合同混入纯重构。后续若统一为查询隔离，应独立修改消费方与测试，同查询后台刷新仍保留数据。验收覆盖 A 切 B、A 晚返回、B 失败、历史页暂停、同查询刷新和详情双请求部分失败。

### M2 重置券组件同时承担业务操作编排

**P2，职责与生命周期。** [ResetCreditAction](../webui/src/components/overview/reset-credit-action.tsx) 约 14 至 26 行分类消费结果不确定的 HTTP 错误，约 37 至 77 行同时负责确认、上游刷新、后端取消与展示。这与前端 README 中组件组合展示、数据操作由 Hook 管理的职责不一致。

其中 `refresh` 约 58 至 64 行没有 `confirm` 与 `cancel` 使用的同步 `actionInFlight` 防护，也未传入组件生命周期的取消信号。直接连续调用该处理函数可以重复发起请求；这证明函数缺少防重，不等于已经证明浏览器可通过普通双击触发，因为按钮还有 React 禁用态防护。请求仍受公共 API 超时限制，本项不是无限等待问题。

建议把重置券操作编排移入专用领域 Hook，继续复用公共确认机制，统一同步防重和卸载取消；组件保留展示、选择与开关。必须保留 `reset_unknown` 表示结果不确定、不能盲目重试的语义。已有 [重置券测试](../tests/webui-reset-credits.test.ts) 覆盖取消与确认竞争、不确定结果分类，应保留并补刷新重入、卸载后不触发旧回调的验证。

### 模块化取舍

当前无需为所有功能创建新的 Store、仓储层或通用 CRUD 框架。页面多数通过领域 Hook 获取数据，公共 API 封装负责认证与错误，类型从共享声明转出。改进重点是收敛已出现的相同编排，以及将少数领域操作从展示组件移出。Traffic 详情、账户观测时间合并、版本化设置与普通指标的语义不同，不应为了减少行数强行共用一个万能 Hook。

## 状态管理与依赖决策

### S1 SSE 把网络读取块当作单帧限制

**P2，已隔离复现。** [API 客户端](../webui/src/lib/api.ts) 约 106 至 109 行先将 `reader.read()` 得到的文本追加到缓冲区，检查总长度是否超过 4096，然后才按 `\n\n` 拆帧。网络读取块可以包含多个事件，所以多个合法小帧合并超过上限也会被拒绝。

审查使用真实 `watchDeliveryQueue` 与模拟 `ReadableStream`：一次交付 200 个合法 `changed` 帧，共 5200 字符，实际交付事件数为 0，抛出 `Queue stream frame too large`。其他通知入口复用同一解析器，也受这一条件影响。未测量实际服务中的出现概率，不据此声称生产环境已经频繁断流。

建议按完整帧与尚未结束的帧分别限制长度，保持未知事件拒绝、取消和资源释放行为。验收补充“大块内含多个合法帧应全部交付”“单个超长完整帧拒绝”“未结束超长帧拒绝”和跨块分帧。已有 [通知测试](../tests/webui-delivery-events.test.ts) 约 77 行覆盖少量合并、分片、鉴权和非法帧，但未覆盖此次边界。

### S2 登录验证请求缺少有界等待

**P2，静态确认。** [AuthGate](../webui/src/components/layout/auth-gate.tsx) 约 73 行的令牌验证使用原始 `fetch`，没有超时与卸载取消；普通 [requestJson](../webui/src/lib/api.ts) 约 136 行已有 30 秒超时。连接一直未结束时，登录表单保持 `submitting`，输入与按钮持续禁用，缺少应用层确定的恢复时间。

建议为这一已获项目允许的独立鉴权请求增加明确超时和卸载清理，失败后恢复输入；保留验证成功后才保存候选令牌的行为。验收以挂起请求、超时、失败重试、卸载和成功登录为边界，不使用真实令牌或连接用户服务。

### 状态归属与状态库选择

| 状态 | 当前归属 | 建议 |
| --- | --- | --- |
| 筛选、排序、分页、详情定位 | URL 与查询 Hook | 保持 URL 为事实来源，避免再复制到全局 Store |
| 输入草稿、展开、选中项 | 组件状态与 `useSettingsDraft` | 保持就近归属，草稿与服务端已保存值明确区分 |
| 语言、主题、服务端时间 | Context 与现有 Provider | 当前共享范围明确，暂无迁移理由 |
| 列显隐等展示偏好 | DataTable 与浏览器存储 | 保留局部持久化，不与接口数据混用 |
| API 快照与刷新 | `useApi`、领域 Hook、SSE 与刷新调度 | 优先修复边界与收敛重复；保留历史分页暂停等领域语义 |
| 管理预览、确认与写操作 | 公共管理 Hook、版本化设置 Hook | 保留确认令牌、取消、版本检查；不自动重试写操作 |

**当前不建议引入 Redux 或 Zustand，也不建议立即整体迁移 TanStack Query。** 源码证据表明当前问题主要是公共 Hook 重复、边界一致性和少量错误路径，尚无需要全局 Store 才能解决的跨页面高频共享写状态。React 官方建议减少冗余状态及需要同步的副本，支持先明确状态归属的方向，不能单凭 Hook 数量决定加库：[React 状态结构](https://react.dev/learn/choosing-the-state-structure)。

客户端全局状态库与服务端缓存库解决的问题不同。F2 已确认同页账户卡重复读取同一配置，但可以先通过页面共享读取解决，无需全局缓存。若局部复用后，多资源跨页面缓存及失效成本仍持续增加，再选一个只读域试点 TanStack Query，比较迁移前后请求数、代码量、竞态覆盖和维护成本。它不能直接取代 SSE 协议与管理确认。官方查询重试默认行为需要显式评估，不能直接套用于本项目现有刷新策略：[TanStack Query 查询重试](https://tanstack.com/query/latest/docs/framework/react/guides/query-retries)。

重新评估引入客户端 Store 的条件：出现多个独立页面共同编辑同一份客户端工作状态、状态传递确实跨越多层无关组件，或经性能分析确认需要细粒度订阅。没有这些证据前，先使用局部状态、Context 或领域内 reducer，不为潜在需求增加依赖。

## 验证与最终计划

### V1 补齐真实生命周期与键盘交互证据

**P2，验证覆盖改进。** 当前已有纯函数、调度器、服务端接口、SSR 展示及模拟 Hook 测试，不能概括为“没有前端测试”。但 [设置展示测试](../tests/webui-settings-presentation.test.ts) 约 46 行用普通元素替代真实 AlertDialog，[轮询测试](../tests/webui-api-polling.test.ts) 使用手写 Hook 环境。它们不能证明实际 DOM 焦点、Escape、Effect 清理顺序和 StrictMode 重挂载行为。

建议保留现有快速测试，针对高风险交互增加少量真实 React 生命周期或浏览器合同：查询切换与取消、StrictMode 重挂载不重复订阅、隐藏列后键盘操作、真实确认弹窗焦点恢复。纯函数继续用现有测试；不以大规模端到端套件替代它们。新增测试依赖须在实施时说明必要性、维护成本与移除方式，本次未添加依赖。

### 整改顺序与验收

以下为全面审查确认的整改范围。原始问题描述对应审查基线，不代表修改后的代码仍有同一问题；实施进度与最终验证见后面的关联修复记录。

| 问题 | 等级 | 类型 | 处理目标 |
| --- | --- | --- | --- |
| A1 | P2 | 故障恢复 | 非法路径不使布局渲染中断，页面失败有恢复入口 |
| C1 | P2 | 登录可靠性 | 存储失败不当作登录成功后循环刷新 |
| C2 | P2 | 风险文案 | 英文保留禁止重复签发的完整含义 |
| C3 | P3 | 输入呈现 | 非法 URL range 不显示内部翻译键 |
| D1 | P3 | 基础组件接口 | Tabs 方向透传及横纵合同 |
| D2 | P2 | 错误分类 | 登录服务故障不误报无效令牌 |
| E1 | P3 | 样式重复 | FastBadge 复用已有尺寸参数 |
| F1 | P2 | 错误恢复 | 账户配置失败后只读重试可用 |
| F2 | P3 | 请求重复 | 多账户卡共享同资源配置读取 |
| H1 | P3 | 交互状态 | 正文变化后旧复制成功反馈失效 |
| K1 | P3 | 组件重复 | StatusRow 复用 SettingsRow |
| L1 | P2 | 分层 | Relay 目录操作下沉领域 Hook |
| L2 | P2 | 分层 | Relay Key 领域规则从页面分离 |
| UI1 | P2 | 可访问性 | 隐藏列后仍有键盘详情入口 |
| UI2 | P2 | 可访问性 | 字段错误关联对应输入 |
| UI3 | P3 | 展示重复 | 输出 Token 提示复用，输入口径保持 |
| M1 | P2 | 编排重复 | 指标快照 Hook 收敛，先保持现有合同 |
| M2 | P2 | 分层与生命周期 | 重置券操作集中，刷新取消与防重明确 |
| S1 | P2 | 通知可靠性 | SSE 按帧限制而非网络块限制 |
| S2 | P2 | 登录可靠性 | 验证超时、卸载取消和恢复 |
| V1 | P2 | 验证覆盖 | 补真实生命周期与键盘交互合同 |

| 顺序 | 工作包 | 完成标准 |
| --- | --- | --- |
| 1 | 错误恢复 F1、S2、D2、C1、A1 | 失败后能安全重试；不会无限禁用、假登录成功或因非法路径中断整个布局 |
| 2 | 通知与风险提示 S1、C2 | 合法大合并块交付完整，单帧超限仍拒绝；中英文均阻止误判已提交操作为可重复签发 |
| 3 | 可访问性 UI1、UI2 | 列隐藏后键盘入口保留；无效字段关联错误；真实键盘与焦点验收完成 |
| 4 | 领域边界 M2、L1、L2 | 组件/页面负责组合；请求与领域规则有明确所有者；确认、取消及一次性结果语义不变 |
| 5 | 窄范围去重 M1、F2、UI3、K1、E1 | 复用已存在合同和组件；同资源读取共享；不改变缓存命中率等统计口径 |
| 6 | 辅助边界 C3、D1、H1 | 非法范围有明确错误；基础方向属性可靠；复制状态跟随内容身份 |
| 持续 | 随上述任务补 V1 | 每个行为修复带回归；补少量真实生命周期与键盘合同，保留现有纯函数测试 |
| 条件触发 | 根据测量重新评估状态库 | 局部复用后仍有跨资源缓存或共享写状态成本才单域试点；不同时维护两套事实来源 |

### 审查阶段验证记录（修复前）

以下记录保留首次全面审查的证据与当时的限制；追加修复后的验证单独列在文末，不沿用已经发生代码变化的旧结果。

- `npm run lint --prefix webui`：第一轮通过，源码与规则未变，本轮沿用结果。
- `npm run build --prefix webui`：本轮通过，TypeScript 检查及 Vite 生产构建成功，实际生成页面级 chunk；未把构建体积当成已经测量的交互性能。
- `npm run i18n:check`：本轮通过，957 个中文源键、中英文键及占位符一致；另人工核对全部字典语义，发现 C2。
- 第一批 `npx vitest run`：`webui-settings-state`、`webui-range-refresh`、`webui-api-polling`、`webui-delivery-events`、`webui-tables`、`webui-settings-presentation` 六个 `.test.ts` 文件，91 项通过，源码未变沿用结果。
- 本轮补充 `npx vitest run`：`webui-account-refresh-state`、`webui-overview-state`、`webui-traffic-state`、`webui-query-token`、`webui-i18n-tool`、`webui-i18n`、`webui-model-management`、`webui-relay-page`、`webui-logs-page`、`webui-settings-navigation`、`webui-delivery-page` 十一个 `.test.ts` 文件，104 项通过。两批合计 17 个测试文件、195 项通过。
- 隔离执行复现：S1 合法 SSE 合并块拒绝；A1 真实面包屑畸形路径抛错；C1 两种 Storage 不可用时令牌静默丢失；D1 Tabs vertical 未传入 primitive；F1 真实账户组件错误分支重试禁用；C3 真实筛选器输出非法翻译键。SSR 复现不是浏览器交互测试。
- 文件覆盖与 TypeScript AST 依赖检查：161 个源码文件均匹配已完成模块；无内部静态运行时依赖环；跨目录运行时纯函数已补读。
- `npm run docs:check` 与 `git diff --check`：通过，97 个 Markdown 文件的索引与本地链接一致。
- 本轮未运行 Gateway 全量构建、全仓测试或后端全部 API/IPC 测试；文中测试入口不等于都在本次执行。未运行 `verify:commit`，未提交或推送。
- 未进行真实浏览器视觉、读屏、键盘/焦点、DOM 生命周期和性能剖析。环境没有可用浏览器工具或已安装 Playwright、DOM 测试环境；此次未引入测试依赖。动态验收缺口保留为 V1，不能把源码全覆盖等同于用户交互全覆盖。

### 全面源码审查结论

161 个前端源码文件和所列工程配置、共享依赖已完成逐模块审查。现有组件体系与大部分领域边界成立，静态运行时依赖无环；问题集中在错误恢复、输入边界、可访问性、少数展示层操作编排和局部重复。登记 21 项：14 项 P2、7 项 P3，其中包含维护和验证改进，不代表 21 个已发生的用户故障。本次没有确认 P1 问题，但未进行的动态验收仍可能发现新问题。

不建议引入 Redux/Zustand 或全面迁移 TanStack Query。修复采用小型领域 Hook、公共组件及账户组共享读取，保留确认、取消、历史分页和账户观测时间语义。需要评估服务端缓存库时，以整理后的实际重复请求和跨页面成本为依据，不以 Hook 数量或文件长度为依据。

## 关联修复记录

修复阶段不增加项目依赖，不改变后端接口、持久化格式或 App Server 协议。浏览器合同使用独立临时安装的 Playwright 和 Chromium，测试仅连接隔离夹具。

| 链路 | 对应问题 | 已落地修改 | 当前验证 |
| --- | --- | --- | --- |
| URL 令牌 → 存储 → 登录请求 → 应用入口 | C1、D2、S2 | `setToken` 返回实际可读取结果；查询令牌先清除 URL，再反馈存储失败；登录使用表单提交、同步锁、30 秒超时与卸载取消，区分鉴权失败与服务失败 | 令牌回归与真实浏览器合同通过 |
| 导航 → 路由 → 懒加载 → 恢复入口 | A1 | 路径安全解码；非法地址与未知路由有返回入口；页面错误边界按路由重置；组合路由链接正确声明非原生按钮 | 实际 App 畸形路径与错误恢复浏览器合同通过 |
| URL 范围 → 筛选展示 → 查询提交 | C3 | 非法范围显示本地化提示，要求重新选择；不将非法值静默改成合法 API 查询 | 非法范围和合法 24h/90d/all/custom 双语回归通过 |
| 通知流 → 单帧限制 → 共享订阅 | S1 | 按完整帧与剩余半帧分别限制，保留 4096 字符及跨块分隔符边界 | 合并 200 帧、超长完整/半帧、边界分片回归通过 |
| 查询 → 指标快照 → 列表/详情 → 历史分页 | M1 | 四个指标 Hook 复用 `useMetricsSnapshot`；保留旧数据加载合同、历史暂停和详情双请求原子发布 | 轮询与详情回归、真实请求取消和订阅清理合同通过 |
| 账户组 → 配置读取 → 删除预览 → 单个确认框 | F1、F2 | 多卡共享管理控制器；读取失败可重试，错误状态不能删除；确认仍绑定具体账户，卡片消失不丢失待确认状态 | 账户组合回归通过 |
| Relay 页面 → 草稿与权限 → 预览确认 → 一次性结果 | L1、L2、C2 | 目录更新与 Key 编辑下沉领域 Hook；拆分表格/弹窗；保留版本校验、能力过滤和一次性密钥；中英文完整提示不要重复签发 | Relay 前端回归及隔离 IPC 合同通过 |
| 重置券展示 → 刷新/预览/确认/取消 → 账户刷新 | M2 | 专用 Hook 持有同步操作锁与取消信号；结果不确定仍不能盲目重试 | 业务、隔离 IPC 及真实卸载合同通过 |
| 持久列偏好 → 表格按钮 → 抽屉焦点 | UI1 | 必要操作列覆盖旧隐藏偏好；原生按钮保留键盘入口，关闭详情恢复触发按钮焦点 | 表格回归及 Enter/Escape/焦点浏览器合同通过 |
| 字段 → 错误提示；Tabs → primitive；公共展示组件 | UI2、UI3、D1、E1、K1 | 错误关联输入，方向透传，输出 Token 提示、Badge 尺寸和设置行复用；输入缓存率口径保持 | 组件回归及纵向 Tabs 键盘合同通过 |
| 正文 → 异步剪贴板 → 反馈 | H1 | 反馈绑定正文版本；旧复制 Promise 不能覆盖新正文状态 | 正文变化与迟到成功/失败回归通过 |
| 真实 React 挂载 → 用户交互 → 清理 | V1 | 新增可复用浏览器合同，与快速 SSR/模拟 Hook 测试互补 | 13 个 Chromium / StrictMode 合同通过 |

### 修复后的整合验证

- `npm run build`、`npm run check`：通过，Gateway 当前源码产物、根目录类型与运行时依赖检查完成；后续 IPC 测试使用本次构建产物。
- `npm --prefix webui run build`、`npm --prefix webui run lint`：通过，前端类型、生产构建与 Lint 完成。
- `npm run i18n:check`：通过，967 个中文源键，中英文键及占位符一致；风险文案含义另有回归断言。
- 20 个关联测试文件、231 项全部通过：`webui-api-polling`、`webui-query-token`、`webui-delivery-events`、`webui-relay-page`、`webui-reset-credits`、`webui-settings-presentation`、`webui-tables`、`webui-traffic-state`、`webui-i18n`、`webui-component-contracts`、`webui-overview-state`、`webui-account-refresh-state`、`webui-settings-state`、`webui-model-management`、`webui-delivery-page`、`webui-logs-page`、`webui-range-refresh`、`webui-settings-navigation`、`webui-relay-management`、`webui-traffic-events`（均为 `tests/*.test.ts`）。包含 Relay 与重置券的真实隔离 IPC 合同，无过滤或跳过。
- 10 个修改后的 TypeScript 测试文件 ESLint 与 `git diff --check`：通过。
- 最终 `npm run docs:check`：通过，97 个 Markdown 文件的索引与本地链接一致；浏览器脚本 `node --check` 通过。
- [真实浏览器脚本](../tests/browser/webui-contracts.mjs) 与 [React 夹具](../tests/browser/webui-fixture.jsx)：13 项全部通过。覆盖 Enter 登录、503/401 区分、双存储失败、成功保存后重载、卸载取消、超时恢复、查询替换和迟到响应、重置券刷新重入/卸载、纵向 Tabs 方向键与 Enter 激活、旧列偏好下的详情入口及 Escape 焦点恢复、确认框取消初始焦点及忙时阻止关闭、StrictMode 单一有效订阅及卸载清理、实际 App 非法编码路径、页面异常恢复与异常文本隔离。
- 浏览器实测发现新增恢复页的链接组合缺少 `nativeButton={false}`，已修正并核对其他同类调用方；其余既有调用已正确设置。13 项成功运行发生在这一修复之后。随后重新通过 WebUI 构建与 Lint。
- 浏览器环境曾因缺少 NSS/NSPR、图形运行库和字体组件启动失败或无法正常显示/输入，这些尝试不计为通过。Playwright 1.63.0、Chromium 153 及所需 Debian 运行库只下载或解压至 `/tmp/codexc-browser-review`；系统字体配置使用该目录的独立 `fonts.conf`，没有安装系统包或修改项目依赖。最小 HTML 显示与输入验证通过后，才执行上面的完整合同。

本环境的成功执行命令（普通已具备 Chromium 运行库的环境见 [测试说明](../tests/README.md#webui-真实浏览器合同)）：

```bash
FONTCONFIG_FILE=/tmp/codexc-browser-review/fonts.conf \
LD_LIBRARY_PATH=/tmp/codexc-browser-review/libs/usr/lib/x86_64-linux-gnu \
PLAYWRIGHT_BROWSERS_PATH=/tmp/codexc-browser-review/browsers \
node tests/browser/webui-contracts.mjs /tmp/codexc-browser-review/node_modules/playwright/index.mjs
```

### 完成范围与剩余限制

21 项登记任务均已实现并关联复核调用方、测试和文档；未引入 Redux、Zustand 或新的服务端状态库。审查确认的重复通过领域 Hook、公共组件与账户组共享控制器收敛，没有增加第二套全局数据来源。

此次浏览器合同使用真实 React/Chromium 和受控 API；它证明所列 DOM、键盘和生命周期行为，不代表真实账户上游、所有页面视觉布局、屏幕阅读器、Firefox/Safari 或性能剖析均已验收。没有连接当前用户服务执行管理写操作。未运行全仓测试、完整 `verify:commit` 或真实 App Server 协议合同，本次未改变后端/API/协议语义；未提交或推送。

## 修复后第二轮关联审查

按追加要求，对当前完整未提交改动重新审查；上一轮通过结果作为已有证据，不替代对调用条件、失败恢复和回归的复核。保留既有改动，只对确认的问题继续修复。

| 链路 | 本轮重点 | 状态 |
| --- | --- | --- |
| 登录、启动、路由和查询输入 | 存储优先级、候选验证、超时取消、恢复入口、非法 URL | 已复核，未确认新缺陷 |
| 指标、订阅、账户组和正文 | 查询归属、历史暂停、确认绑定、共享读取与迟到结果 | 已复核，未确认新缺陷 |
| Relay 与重置券 | 草稿版本、同步互斥、一次性确认、卸载及操作后刷新 | 已复核，补充目录浏览器合同通过 |
| 公共 UI 与验证合同 | 列偏好、键盘焦点、错误生命周期、测试盲区 | 已复核，R1 已修复，浏览器回归通过 |

### R1：后台快照更新后压缩设置仍显示过期错误（P2）

- 证据：真实浏览器中先输入压缩百分比 `80`、窗口留空并保存，再令服务器快照的窗口变为 `1000`。窗口正常跟随新快照、百分比草稿保留，但旧的“设置自动压缩百分比前必须先设置模型上下文窗口”提示与 `aria-invalid` 仍保留，等待错误消失的合同在修复前失败。
- 根因：`useSettingsDraft` 正确合并服务器未编辑字段与用户草稿；`AppServerSettingsCard` 的独立错误状态没有绑定触发错误的有效字段值。这是本轮补充确认的既有遗漏，不是领域 Hook 拆分引入的回归。
- 已落地修复：将错误绑定相应字段值；窗口依赖错误同时关联百分比。刷新修复对应输入时停止呈现过期错误，其他字段变化不能清掉仍然非法的草稿反馈。覆盖字段值、错误文本、ARIA 关联及最终预览载荷。
- 旁路复核：ToolAccess 的非法 JSON 必然属于用户编辑草稿，合法服务器值不会覆盖它；增加保留草稿与错误的合同，不为未经确认的问题修改生产逻辑。

另补充 Relay 目录 Hook 的真实 StrictMode 重挂载、卸载后迟到响应、下载互斥、失败后手动重试和成功后不循环下载合同。两项新增合同与原 13 项同时通过；这组通过发生在 R1 修复前，不能替代修复后的重新验证。

### 第二轮修复后验证与结论

- R1 浏览器回归先失败、修复后通过；最终全部 16 项 Chromium / React StrictMode 合同通过，包括新增设置刷新场景和两项 Relay 目录场景。
- `npm --prefix webui run build`、`npm --prefix webui run lint`：本轮修复后通过。
- `webui-settings-state`、`webui-settings-presentation`、`webui-model-management` 三个测试文件、10 项关联测试：本轮通过。
- `webui-component-contracts` 的 5 项组件合同及该测试文件 ESLint：本轮通过。新增断言同时验证修复过期反馈、保留非法百分比及非法 JSON 草稿的错误；合计本轮运行 4 个测试文件、15 项测试。
- `npm run docs:check`、浏览器脚本语法检查及 `git diff --check`：通过；文档索引检查覆盖 97 个 Markdown 文件。
- 其余未变化链路的既有运行结果保留为首轮证据，不声称本轮重新执行了全部 231 项测试。

第二轮确认 1 项 P2，已修复；其他已复核链路未发现可确认的新缺陷。继续采用现有状态所有权与领域 Hook，无需为此次问题引入全局状态管理库。真实浏览器仍未覆盖 Relay 全部弹窗间焦点切换及所有设置分支，也未开展全页面视觉、读屏、Firefox/Safari 或性能验收；源码审查与局部交互合同不替代这些验收。未修改后端接口或协议语义，未连接用户服务执行管理写操作，未提交或推送。
