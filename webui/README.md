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
i18n-glossary.json  翻译术语、原样保留项和规则，供开发工具生成翻译任务
.npmignore  覆盖本目录的 Git 忽略规则，确保构建后的 dist 进入 npm tarball
src/
  lib/         API 客户端、令牌存取、共享类型转出与格式化；api-polling.ts 管理请求结束后的刷新计时、页面可见性和设置页恢复事件的延后补查，server-time.ts 管理服务端时钟推进与恢复页面后的校准调度，format.ts 统一服务端时区展示，trend.ts 按服务端日期补齐日图表并呈现单日小时统计；metrics-query.ts 统一查询参数和逐层跳转地址，overview-state.ts 保证控制台快照属于当前加载批次，account-refresh-state.ts 投影 OpenAI 当前周额度、Credits 余额和重置券到期明细，并管理有界手动查询失败记录、有界并发查询、逐账户结果交付、观测时间合并及 DS、OCG、CCG、Cline Pass 账户快照时效，traffic-state.ts 隔离不同转储查询的结果并生成精确关联地址，i18n/ 存放中英文界面文案字典与取值函数
  hooks/       数据 hook（useApi 统一 loading/error/refetch，支持按当前状态更新和账户观测时间合并，useApiPolling 复用自动刷新调度，use-dashboard 整批加载概览、趋势和热力图，use-server-time 在页面呈现前初始化服务端时区，并通过上下文共享已校准时间基准）、use-metrics-query（URL 筛选/排序/分页）、use-traffic-query（调用详情页 URL 提供商、批次筛选、独立明细提供商/批次与分页）、use-metrics-export（可取消请求导出）、use-traffic（转储列表与明细）、Relay 服务管理 use-relay-service-management（统一手动、页面恢复及任务完成刷新）、Relay Key 管理 use-relay-management（复用确认 Hook）、use-relay-queue（队列页面挂载期间的 SSE 推送与有界快照刷新），设置管理（共用版本化预览/确认状态机，use-settings-draft 按字段保留未提交草稿）、全局货币上下文与 use-translation（按当前显示语言翻译界面文案）
  pages/       relay-queue-page 独立实时请求队列页；thread-subagents-page 组合全部子代理和所属会话的关联子代理独立页；model-management-page 组合提供商、账户与凭据、模型配置、上下文与压缩四个独立路由，channels-page 组合渠道配置和消息展示，settings-page 组合常规、权限、网络、数据、服务五个子页；概览、会话、会话详情、请求、错误、调用详情、渠道投递队列、模型转发（独立 Key 管理，中文用途名称及居中弹窗，手动刷新运行状态）、设置（只负责组合设置域组件）
  App.tsx      路由布局与页面级懒加载，保留页面切换间的控制台已应用范围及有界账户手动查询失败记录（不保存账户快照）（令牌登录由 AuthGate 与 main.tsx 启动入口协作）
```

令牌登录：服务端配置访问令牌时，API 返回 401 会显示令牌输入页；令牌存入浏览器
`localStorage`，重新打开浏览器仍可复用，也可用 `?token=` 查询参数（放在 `#` 前或 HashRouter 路径中均可）打开页面自动登录。
该令牌同时用于指标读取和设置页的低风险预览/修改。
持久存储不可用时尝试会话存储；两者均不可用或写入后仍只能读到旧令牌时，登录页明确报错，不刷新页面。
查询参数中的令牌先从当前 URL 清除，保存失败同样回到登录页。手动验证限时 30 秒，离开登录界面会取消请求；401/403 与服务故障分别提示。

`components/layout/page-recovery.tsx` 提供非法地址与页面渲染失败的恢复入口；`App.tsx` 在会话路径解码边界拦截非法编码，并按路由重置页面错误边界。

全局深色/浅色主题默认深色，右上角按钮切换，选择存入浏览器 `localStorage`
（`next-themes`），刷新后保持。

API 响应类型不是前端手写镜像：`src/lib/types.ts` 只转出
`scripts/webui-api.ts` 的共享声明，服务端与前端使用同一份类型。

## UI 组件规范

- 组件使用官方 `base-nova` 样式和 `@base-ui/react`，类名合并统一使用 `cn` 包。组合触发器使用 `render`，Select 显式提供 `items` 的值与显示标签，ToggleGroup 的受控值使用数组；不保留 Radix 调用接口。
- `components/ui/toast.tsx` 提供 Base UI 通知容器，`toast-manager.ts` 提供共享通知管理器；`App.tsx` 挂载容器，默认 3 秒关闭并本地化关闭按钮。成功通知短暂显示，错误及需要处理的警告仍保留在操作区域。

- 基础 UI 组件放在 `components/ui/`，只通过 `npx shadcn@latest add` 安装或升级，
  不手写基础组件（按钮、卡片、表格、弹层等）；
- 业务组件按领域分目录组合：`components/layout/`（布局与鉴权）、
  `components/overview/`、`components/threads/`、`components/metrics/`（指标区块），
  `components/requests/`（请求明细数据表格），只做组件组合与数据编排，不直接发请求；
- 数据获取统一走 `hooks/`（`useApi` 系列，集中 loading/error/refetch；设置变更共用版本化预览/确认 Hook），组件不直接
  `fetch`（唯一例外：`AuthGate` 在提交令牌前用原始请求验证一次）；API 路径统一从
  `src/lib/api.ts` 的 `API_PREFIX` 拼接；
- 类型从 `src/lib/types.ts` 转出，格式化（Token/时间）放 `src/lib/format.ts`；已本地化的时间预设标签放 `src/lib/i18n/messages.ts`，
  控制台与各查询页复用 `components/metrics/range-selector.tsx` 的时间及日期控件；
  `use-metrics-query` 读取 Provider 筛选选项并保留多选 URL 参数，`query-filters` 使用勾选下拉；
- 界面翻译通过 `hooks/use-translation.ts` 接入，字典与取值函数位于 `lib/i18n/`，语言状态由
  `hooks/language-context.ts` 与 `language-provider.tsx` 管理。翻译约定、UI 文案参数、覆盖阶段及验收统一见
  [本目录国际化维护约定](#国际化维护)。
- 页面（`pages/`）只负责组合区块与路由参数，业务规则不写进页面；
- 遵守 oxlint 规则：Hooks 必须在组件顶层调用，文件默认只导出组件
  （`react/only-export-components`）。

详细行为见 `docs/webui.md`。

`pages/logs-page.tsx` 组合「调用监控 → 服务日志」（`#/logs`）；`components/service-logs/service-logs.tsx` 使用官方 `components/ui/tabs.tsx` 切换服务，搜索与行数、级别和刷新设置同排展示；`log-results.tsx` 组合撑满页面剩余高度的结构化表格、详情和阅读时的快照保留，日志在表格区域内滚动；`lib/service-logs.ts` 解析已脱敏的 Pino/tracing 日志及 journald 白名单元数据、合并来源并筛选，不猜测未知级别。`hooks/use-service-logs.ts` 复用统一请求与可见页面刷新调度，切换查询隔离旧结果，离开页面取消读取。

`pages/delivery-page.tsx` 组合渠道投递队列独立页面，由左侧「消息渠道 → 渠道投递队列」进入 `#/delivery`；`components/delivery/delivery-queue.tsx` 提供精简表格列表、状态计数筛选、行内内容摘要、游标分页和勾选批量重试/忽略确认；`hooks/use-delivery-queue.ts` 复用管理确认 Hook 与 `hooks/use-queue-events.ts` 的 SSE 变化订阅，筛选或翻页时重建当前查询，离开页面时取消请求。

`components/settings/tool-access-settings.tsx` 组合电脑、浏览器与已有 MCP 的原生配置编辑器，复用 App Server 设置 Hook 的版本化预览和确认；用户层与合并配置分开展示。

请求列表与错误列表不依赖调用采集或转储索引。`components/requests/request-detail.tsx` 仅展示已选指标快照，报文链接为可选入口；请求模型旁的实际上游与尝试次数提示来自独立指标字段，详情展示受限诊断摘要；调用列表只加载摘要，Turn State 诊断保留在单次详情。

调用详情正文复用 `components/traffic/traffic-content.tsx` 的延迟展开与只读文本操作组件，统一复制、换行、格式化和截断提示。

`hooks/use-traffic.ts` 为当前调用列表或详情复用变化订阅，未显示的一侧不订阅；首页按转储文件变化合并读取，历史列表及原始事件分页暂停自动更新。详情按提供商及批次订阅、按调用 ID 精确读取，终态先补读原始事件，事件数变化时重建摘要以补齐迟到输出；手动刷新重新加载完整摘要。同查询后台读取保留内容和展开状态，记录已清理时明确显示缺失；最初尚未写入的记录在新通知到达后可补查。请求详情抽屉跟随列表中相同 ID 的记录更新；记录移出当前页时保留最后一次显示的数据。

`components/metrics/service-tier.tsx` 为请求明细、错误记录和调用详情提供 Fast 标签；前两者使用请求层级，调用详情区分请求与响应来源。
`components/requests/errors-table.tsx` 组合错误记录列、错误说明和会话/轮次跳转；`components/traffic/traffic-table.tsx` 组合调用列表及详情入口。两者与渠道投递队列、请求、会话页复用 `DataTable` 的标题摘要、列显隐、滚动区和服务端分页。公共组件支持标题操作区、业务工具栏、稳定行 ID 及行点击；日志使用不分页模式、行内详情和表格视口滚动回调。

`components/metrics/data-table.tsx` 的 `TruncatedText` 按实际溢出显示全文提示，`SortableHeader` 复用排序按钮展示列口径；提示延迟由 `App.tsx` 的 Provider 统一设置。
必要操作列显式使用 `enableHiding: false`，公共表格覆盖这些列的旧隐藏偏好，保留其他列的用户选择。请求详情原生按钮打开抽屉后，关闭时恢复到仍存在的触发按钮；调用时间按钮同样保留键盘入口。

`components/ui/dialog.tsx`：使用 Base UI/shadcn 居中弹窗，关闭按钮名称由调用方本地化；Relay 表单和一次性密钥结果复用此组件。确认操作使用 AlertDialog，并将初始焦点设到取消按钮；忙碌期间通过根组件的关闭事件阻止退出，`finalFocus` 恢复到操作入口。

`hooks/use-queue-events.ts` 由账户快照、请求指标、渠道投递、Relay 队列与管理任务复用，负责可见性、退避重连、变化合并、快照确认和有限重试；已连接通知中断时补查一次快照，未恢复连接的失败尝试不持续触发读取。管理任务只在变更后读取，终态刷新关联资源，服务状态不在任务执行期间轮询。Relay 侧栏通过现有 DataTable 提供排序、分页和列显隐，耗时表示快照时的值。

`hooks/use-requests.ts` 与 `hooks/use-errors.ts` 复用队列通知 Hook，在 Gateway 指标批次成功落库后更新第一页；历史分页延后读取，返回第一页补查，手动刷新始终可用。`GET /api/v1/metrics/events` 使用只读 API 鉴权，通知中断与快照失败分别显示，不影响历史查询。

`hooks/use-threads.ts` 与 `hooks/use-thread-detail.ts` 沿用指标通知和历史分页暂停规则。会话详情通过 `useThreadDetail` 共用一条订阅，并行读取本地汇总和轮次，两项成功后一起更新；同条件刷新保留内容和展开状态。`useMetricsProviders` 跟随页面成功读取的结果合并更新提供商选项，自动读取至少间隔 30 秒，不另开订阅；后台或离线时暂停，失败可手动重试，不覆盖筛选草稿。
会话列表从同一次响应读取 `totalTokens`，仅展示可排序的“总计”列；悬浮提示上方显示自身输入/缓存/输出，下方显示 `subagentUsage` 的对应分项。页面使用不受分页影响的 `treeAggregate` 展示一份期间汇总，不在浏览器遍历子代理或相减推算缓存。
`hooks/use-metrics-snapshot.ts` 供请求、错误、会话列表和详情复用上述编排。查询变化仍保留旧 `data` 并标记 `loading`，消费方通过加载态隐藏旧结果；不将这一合同推广到有不同查询隔离语义的账户与调用详情。

`components/threads/thread-subagents.tsx` 复用公共 `DataTable`，
展示已登记的直接子代理、会话链接、提供商、模型、自身全部保留历史的轮次与请求数、Token 与缓存指标及下级代理数量；名称与会话 ID 使用原生链接，保留键盘与焦点交互，
用于 `pages/thread-subagents-page.tsx` 的独立页面，支持列显隐、首次请求与最后记录时间排序，以及 10/20/50/100 条服务端分页；其他列不提供排序。左侧“会话 → 子代理”打开 `#/subagents` 全局页，展示全部已登记子代理并增加父会话链接；主列表的子代理数量和详情页的查看入口跳转到所属会话的 `#/threads/:id/subagents`，子代理行的下级数量跳转到下一层独立页面，页面保留返回所属会话入口。主列表仍展示会话累计耗时，其过滤、汇总和分页在服务端完成。
`hooks/use-thread-subagents.ts` 管理独立分页、错误与会话切换隔离，
独立复用指标变化订阅和快照确认，历史分页暂停自动更新；仅查询关联数据，不读取会话详情。关联导航使用全部时间并清除请求筛选。

`pages/thread-detail-page.tsx` 在上方展示筛选与统计，轮次 DataTable 填充剩余高度，表格区域滚动、分页栏位于底部；最小表格高度为窄视口保留可用空间。

`hooks/use-dashboard.ts` 为汇总、趋势和热力图共用一条指标订阅；`hooks/use-official-account-sources.ts` 独立订阅已保存账户快照，仅各账户手动刷新查询上游，进入页面、恢复可见与页头刷新均不触发上游账户查询。
`components/overview/overview-sections.tsx` 在 OpenCode Go 账户组首次需要无订阅管理时挂载单个配置控制器和确认弹窗，所有提示卡复用读取；配置读取失败可以重试，删除仍受读取成功、忙碌态和预览确认限制。
`hooks/use-reset-credits.ts` 组合重置券读取、预览、确认、账户刷新和取消，同步操作锁防止重入，卸载取消并阻止迟到结果触发刷新回调；结果不确定时保留既有禁止盲目重试语义。

`hooks/use-range-refresh.ts` 与 `lib/range-refresh.ts` 为指标页面补充时间范围失效调度：按服务端时区跨日更新今天、昨天及控制台热力图，滚动范围按最后成功请求的开始时间，每 5 分钟校准；后台、离线、历史分页、加载或错误期间不发起时间驱动读取。`components/metrics/refresh-status.tsx` 展示指标及调用页面的通知状态、最后成功读取时间和陈旧提示；跨日调度以成功请求的开始时间为基准，避免零点前读取、零点后返回的旧范围延迟一天才刷新。`useApi` 的成功完成时间用于展示，只随成功结果更新，失败保留内容时保留原时间，取消的请求不能更新时间。

控制台、请求与错误列表区分首次加载和后台刷新：`loading` 仅用于当前查询没有结果时的占位，`refreshing` 用于刷新按钮和操作限制；同查询刷新保留内容，切换查询不展示旧范围结果。管理任务的 `notificationError` 独立于读取错误，通知中断不阻止已成功读取的终态触发关联刷新。

## 国际化维护

当前页面覆盖与剩余验收见 [WebUI 指南](../docs/webui.md)。


界面语言在重新加载后恢复偏好；不改变服务端时区、统计、查询、权限、确认或导出数据。
CLI、渠道消息、Codex 协议和用户内容不在本地化范围内。不翻译模型/提供商 ID、Thread/Turn ID、
配置键、API 参数、日志、调用转储和用户输入。网关返回的原始账户数据保持原样。

中文普通标签使用“提供商”“会话”“轮次”，英文使用 Provider、Thread、Turn；
ID 的标签跟随语言，实际值不变。`Turn State`、`X-Codex-Turn-State` 等协议名称保持原样。

### 翻译维护顺序

中文是源文案。后续获授权的页面或文案变更按以下顺序执行：

1. 提取中文、键、占位符及场景，复用已有键，覆盖加载、空态、失败、重试和可访问名称。
2. 执行者直接生成英文候选并复核，不调用外部翻译服务；中文变更时同步检查既有英文。
3. 经复核后接入字典和组件；不复制中文充当英文、不放宽键或占位符门禁。
4. 验证中英文切换、偏好恢复、英文布局和交互状态保持，记录本批实际覆盖与缺口。

CI 只校验字典，不自动生成、翻译或回写文案；本地差异报告按需使用。
语言切换不得重新提交操作、清空草稿、关闭待确认操作或改变授权范围。

### 本地翻译工具与 CI 校验

以下工具已实现并经本地验证：

- [`webui/i18n-glossary.json`](i18n-glossary.json)：中文术语、英文建议、原样保留项与翻译规则。
- [`scripts/webui-i18n.mjs`](../scripts/webui-i18n.mjs)：使用现有 TypeScript 解析器静态读取字典对象，
  不导入或执行字典模块。仅支持对象和字符串字面量，拒绝展开、计算属性与动态值。
- `npm run i18n:check`：检查空文案、中英文键与占位符；进入本地提交和 CI 共用的 `verify:commit`。
- CI 仅通过共用门禁校验字典，不自动生成报告、调用翻译服务或回写译文。

在仓库根目录运行：

```bash
npm run i18n:check
npm run --silent i18n:report -- --base main > /tmp/webui-i18n-report.json
npm test -- tests/webui-i18n-tool.test.ts tests/webui-i18n.test.ts
```

`--base` 必须是本地可解析的 Git 提交或引用。第一次引入字典时，基线文件不存在会将所有源键列为新增；
逐批审查可指定上一批提交，避免把此前已完成的文案重复列入。报告读取当前工作区，可用于审查未提交修改。

报告条目包含 `new`、`source_changed`、`translation_changed`、`missing_translation`、`removed`，
保留前后中文和英文值，以及 `needsTranslation` / `needsReview`。中文变化即使已有英文也标记待复核；
报告不能判断译文质量，不能把英文“存在”视为翻译已完成。结构问题单列在 `issues`，由检查命令阻止提交。

本地已验证静态提取不执行字典代码、缺失键、占位符差异、中文更新但英文未变、
新增/删除键、首次引入字典和无效 Git 基线。报告仅供本地按需审查。

### 实现约定

- 复用现有 React 语言上下文，内部值保持 `zh` / `en`，页面 `lang` 分别为 `zh-CN` / `en-US`。
  默认中文，偏好写入浏览器 `localStorage` 的 `codex-webui:language`；非法值或读取失败时使用中文，
  写入失败不妨碍本次页面内切换。此偏好不是 Gateway 配置，不写入 TOML 或数据库。
- 字典位于 [`messages.ts`](src/lib/i18n/messages.ts)，中文为键结构基准，英文通过类型检查
  保持同一结构。组件使用 [`useTranslation`](src/hooks/use-translation.ts)，按业务区域组织键。
- 文案优先使用完整句子与 `{name}` 占位符，避免拼接会因语言顺序不同而失效的片段。
  当前数量说明采用不依赖英语单复数词形的表达；后续出现复数需求时同时补齐规则与测试。
  当前取值函数不支持 ICU 或自动复数选择，不得将这些能力视为已实现。
- 动态键必须来自明确的类型或映射，例如导航、日期范围和错误码。静态扫描未识别的键应人工核对，
  不能仅凭扫描结果判断其无用。未知内部错误使用本地化通用提示，不把原始异常直接当作翻译文案。
- 已显示的错误与状态保存结构化标识，在渲染时翻译，避免切换语言后残留旧语言。
  字典中的用户可见文案通过 React 文本渲染，不引入 HTML 翻译或字符串插入 DOM。
- 日期与数字复用项目格式化函数，时间仍以服务端时区为准。后续调整格式时明确语言格式与时区的区别，
  验证日期边界、零值、缺失值与单位，不因翻译改变原始数据。
- 沿用现有 shadcn 组件。基础 UI 组件通过文案参数接收可访问名称，业务组件负责翻译，
  避免基础组件依赖应用语言上下文。Sidebar 的 `mobileTitle` / `mobileDescription` 和
  SheetContent 的 `closeLabel` 由调用方提供。英文文案更长时检查换行、截断、焦点和窄屏布局。

### 验证与交付

中文提取阶段先验证源文案、键设计、占位符和不翻译边界，并记录尚未接入的组件与缺失英文。
以下要求用于英文候选复核后的双语交付；候选来源按当前批次约定，不因门禁擅自改变翻译方式：

1. 中英文键结构、占位符名称与实际调用一致，动态键有明确来源；已覆盖区域没有遗漏的界面文案。
2. 实际切换语言后，已挂载组件、表头、错误和提示更新；偏好恢复、非法值及存储不可用行为正确。
3. 语言变化不改变数据请求语义、筛选值、分页、关联链接、输入草稿和操作确认状态。
4. 已知错误按结构化标识翻译，未知错误使用通用提示；原始内容保持边界，不误译用户数据。
5. 英文长文案、窄屏布局、关闭按钮、表单标签、焦点顺序和页面 `lang` 可用。

针对性验证入口：

```bash
npm test -- tests/webui-i18n.test.ts tests/webui-tables.test.ts tests/webui-settings-presentation.test.ts
npm --prefix webui run build
npm --prefix webui run lint
npm run docs:check
```

[`webui-i18n.test.ts`](../tests/webui-i18n.test.ts)覆盖字典与占位符一致性、语言偏好读取、导航及 Threads
渲染和错误翻译。其他两组测试覆盖共享表格与设置展示回归。
测试通过不等同于完成浏览器布局验收；实际交互和视觉检查应单独记录结果。
真实 React StrictMode、取消与键盘/焦点合同见[浏览器测试入口](../tests/README.md#webui-真实浏览器合同)，使用隔离夹具及临时浏览器工具，不连接当前用户服务。
普通提交通过现有提交钩子执行完整 `verify:commit`，开发阶段按实际改动选择检查，不重复运行全量门禁。

`components/settings/relay-provider-models.tsx` 按提供商显示只读模型目录弹窗与目录更新入口。
`components/settings/relay-key-models.tsx` 在 Key 编辑弹窗按提供商分组勾选模型，可跨多个提供商；独立目录更新不扩大 Key 权限。
`components/settings/relay-model-copy.tsx` 在 Key 列表中提供授权模型 ID 复制菜单、复制结果提示和剪贴板不可用时的手动复制入口。
`hooks/use-relay-catalog.ts` 管理目录下载、一次自动尝试、取消和审计反馈。
`hooks/use-relay-key-editor.ts` 管理 Key 草稿版本、模型能力筛选、提交参数与一次性结果；`components/settings/relay-key-table.tsx` 和 `relay-key-dialogs.tsx` 分别组合列表和编辑/确认/结果弹窗，`pages/relay-page.tsx` 保留页面组合和焦点恢复。
