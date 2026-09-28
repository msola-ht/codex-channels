# WebUI 国际化实施计划

本计划管理 WebUI 中文与英文的接入范围、阶段状态和验收要求。用户操作与当前支持范围见
[`webui.md`](webui.md)，前端目录与组件约束见 [`webui/README.md`](../webui/README.md)。

## 目标与范围

在同一页面内切换中文与 English，让已接入页面的正文、菜单、表格、提示、错误与无障碍标签
跟随所选语言，并在重新加载后恢复偏好。逐条完成页面链路，不能仅翻译导航就宣称全站完成。

本计划仅覆盖 WebUI 展示层。CLI、渠道消息、Codex App Server 协议与用户内容不在本计划范围内。
不翻译或修改模型 ID、Provider ID、Thread/Turn ID、配置键、API 参数、日志正文、调用转储和用户输入。
中文界面的普通标签统一为“提供商”“会话”“轮次”，英文对应 Provider、Thread、Turn；包含 ID 的标签也按语言显示，实际 ID 值保持原样。`Turn State` 与 `X-Codex-Turn-State` 等协议名称仍原样保留。设置页继续延期。
界面语言不改变服务端时区、统计口径、查询范围、权限与确认流程，也不改变导出数据的字段或原始值。

## 执行顺序约束

中文是唯一源文案，先审查并提取中文，再生成英文候选、复核并验收；现有译文不回退。
用户已取消 CI 自动翻译：不再建设翻译服务调用、自动生成报告或自动回写译文的 CI 流程。
后续获授权的文案批次按中文提取 → 执行者直接翻译英文候选 → 复核 → 双语验收推进，
不调用外部翻译服务。阶段三 A 已使用相同的直接翻译方式，已有译文不重做。
CI 保留字典键与占位符校验；本地差异报告按需运行，不作为等待自动翻译的前置条件。

设置页仍将调整，用户已明确要求暂不处理：不新增设置页文案提取、翻译或专门的交互改造，
已有共享组件带来的翻译保留。设置页不进入当前执行队列，待用户明确恢复后再排期。

## 当前状态

截至 2026-09-27，阶段一与阶段二 A（控制台）已在 `feat/webui-i18n` 分支完成实现、针对性验证并提交，
提交为 `af0e5bef`、`806a6985`，翻译准备工具与技能说明分别为 `c703adcf`、`15be5655`。
阶段二 B（请求与错误）展示层实现、导出错误分类修复及针对性验证已完成，提交为 `902031b4`。
阶段三 A（调用列表与详情）展示层已接入中英文，已提交 `19c7cfbd`：调用页、表格、详情、内容折叠、请求内容与
清理控件均已跟随语言，英文由执行模型直接生成（用户要求不调用外部服务），已完成代码审查与针对性验证；
调用记录清理确认分支也已接入，设置页其他操作继续延期。阶段三 B 设置页与阶段四未实施。
本批术语统一修改随本次提交交付：已接入页面的中文普通标签统一为“提供商”“会话”“轮次”，
同步表头、筛选、导航、提示、术语表与用户指南；英文标签含义不变，设置页继续延期。
整条分支尚未推送、合并或部署。后续交付时更新此状态及验证记录，避免将本地实现描述为已发布能力。
CI 自动报告任务已移除，自动翻译接入待办已取消，随本次提交交付。
现有工具保留字典校验和本地按需差异报告，不生成或应用译文。

| 阶段 | 范围 | 状态 | 完成标准 |
| --- | --- | --- | --- |
| 一 | 基础语言状态、导航、登录、Threads 列表与详情，以及链路共用组件 | 已本地提交，待 PR 与交付 | 语言菜单、持久化、页面 `lang`、表头、筛选、分页、空状态、错误和无障碍标签一致 |
| 二 | 控制台、请求与错误页面 | 2A 控制台已提交，剩余边界见下文；2B 请求与错误已提交 `902031b4` | 指标卡、图表、表格、错误分类与交互提示完整覆盖；保留指标含义与数据关联 |
| 三 | 调用列表与详情；设置页面延期 | 3A 展示层与清理确认分支已接入双语，真实浏览器验收待补；3B 设置按用户要求暂不处理，已有共享翻译保留 | 展开内容、状态、表单校验、预览、确认与操作结果完整覆盖；保留原始内容和授权边界 |
| 四 | 全站验收与维护检查 | 待实施 | 页面清单逐项验收，动态键与占位符一致，语言切换无状态丢失，英文布局与无障碍检查通过 |

后续阶段尚未实施；此计划不代表已授权自动提交、发布或部署。

本次术语统一验证：相关组件测试共 55 项通过（首次运行有 1 项仍断言旧英文标签，更新后该测试文件 3 项通过），
前端类型检查、WebUI Lint、462 个字典键及占位符校验、文档检查通过。
CI 配置与本地字典工具的相关 11 项测试通过；完整门禁由正常提交钩子执行。
本批尚未部署或完成真实浏览器视觉验收。

## 换模型后的执行顺序

下一位执行者按下列顺序推进。每批分别记录“中文提取、直接翻译、复核、组件验收”的状态，
不恢复已取消的 CI 翻译自动化。

以下执行步骤适用于后续批次；阶段三 A 当前批次按已有结果收敛，不重做英文生成。

1. **恢复现场并收敛当前批次。** 读取项目规则、本页、`webui/README.md` 及本轮涉及的组件；检查
   `git status --short` 和 `git log -3 --oneline`。阶段一、二 A、二 B 与三 A 本批代码已交付，先核对实际提交与工作区，
   不要重做、丢弃或混入下一批。技能与准备工具已提交；继续使用项目 `i18n-expert` 与 `shadcn` 技能。
   是否提交或推送按用户实际授权执行。
2. **确定后续范围。** 阶段三 A（调用页面及清理确认分支）已完成本批代码接入，先核对剩余的真实浏览器验收。
   设置页继续延期，不自动进入阶段三 B；新页面范围等待用户指定。下述步骤用于后续获授权的文案批次。
   先列出中文原文、拟用键、占位符、所在组件与使用场景；复用已存在的键。
   调用正文、日志、模型与账户名称、配置原值不进入翻译任务。
3. **完成中文提取和审查。** 核对语义、完整句子、空态/加载/失败/重试、菜单、提示及可访问名称，
   生成本批中文变更清单，按需运行本地字典差异报告；先确认中文源文案，再翻译英文。
   现有字典类型与门禁仍要求中英文结构一致：缺少英文的新字典及组件接入只能作为工作区草稿，
   不得复制中文到英文、填假译文或放宽门禁来提交。若需要先独立交付中文提取结果，
   将键、中文、占位符和场景清单记录在本计划的对应批次中，待译文可用后再接入生产字典。
4. **直接翻译英文候选。** 执行者依据本批中文源文案、场景和术语表生成英文，不调用外部服务。
   中文修改即使已有英文，也须复核是否需要同步修改；不重新生成已删除键。
5. **人工复核与接入。** 审查英文候选的含义、术语、占位符与原样保留项；人工可修改候选译文，
   但应记录生成来源和复核结果。应用经过复核的候选后接入组件，完成中英文交互与回归检查。
   翻译更新不得改变筛选、分页、统计、链接、导出内容、草稿或待确认操作。
6. **更新记录再进入下一批。** 分别记录中文提取范围、译文来源与复核结果、
   实际验证和剩余边界。阶段四可先验收已处理页面的桌面、窄屏、键盘及弹窗；设置页恢复并完成前不宣称全站覆盖。

## 本地翻译工具与 CI 校验

以下工具已实现并经本地验证：

- [`webui/i18n-glossary.json`](../webui/i18n-glossary.json)：中文术语、英文建议、原样保留项与翻译规则。
- [`scripts/webui-i18n.mjs`](../scripts/webui-i18n.mjs)：使用现有 TypeScript 解析器静态读取字典对象，
  不导入或执行字典模块。仅支持对象和字符串字面量，拒绝展开、计算属性与动态值。
- `npm run i18n:check`：检查空文案、中英文键与占位符；进入本地提交和 CI 共用的 `verify:commit`。
- CI 仅通过共用门禁校验字典，不自动生成报告、调用翻译服务或回写译文。
  原 `WebUI translation report` Job 已移除。

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

## 实现约定

- 复用现有 React 语言上下文，内部值保持 `zh` / `en`，页面 `lang` 分别为 `zh-CN` / `en-US`。
  默认中文，偏好写入浏览器 `localStorage` 的 `codex-webui:language`；非法值或读取失败时使用中文，
  写入失败不妨碍本次页面内切换。此偏好不是 Gateway 配置，不写入 TOML 或数据库。
- 字典位于 [`messages.ts`](../webui/src/lib/i18n/messages.ts)，中文为键结构基准，英文通过类型检查
  保持同一结构。组件使用 [`useTranslation`](../webui/src/hooks/use-translation.ts)，按业务区域组织键。
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

## 分阶段实施

### 阶段一：导航、登录与 Threads

已接入导航与面包屑、布局加载状态、主题和语言菜单、登录表单与验证结果、Threads 列表、
线程详情和每轮明细。共享查询组件覆盖日期范围、筛选条件、摘要、分页、列选择、空状态与加载错误。
移动侧栏说明及筛选面板关闭标签由业务层传入翻译。

Threads、Provider 列表与服务端时间查询保留结构化错误码供展示层选择文案。
登录页在验证前提供语言选择，已显示的验证错误随语言变化。表格翻译跟随语言更新，
保留原有查询、排序、模型显示规则和 Thread/Turn 链接。

### 阶段二：控制台、请求与错误

按“加载 → 有数据 → 空数据 → 失败 → 重试”逐页检查，覆盖指标卡、账户与额度状态、图表标题和图例、
请求列与提示、错误筛选和类型说明。区分零值、未知值与未观测状态，不通过翻译推断上游状态。
既有错误翻译与新字典应统一接入责任，避免出现两套相互覆盖的文案来源。

### 阶段三：调用详情；设置延期

阶段三 A 覆盖调用摘要、请求与响应的界面标签、轨迹分页、展开/复制控件，以及加载、错误与重试。
原始请求、响应、日志、模型名和配置值保持原样。

#### 阶段三 A 中文源文案与英文接入清单

范围：`webui/src/pages/traffic-page.tsx` 与 `webui/src/components/traffic/`
（`traffic-table.tsx`、`traffic-detail.tsx`、`traffic-content.tsx`、
`traffic-request-content.tsx`、`traffic-cleanup-controls.tsx`），以及它们直接使用的共享控件
（`FastBadge`、`TrafficModel`、`ErrorBanner`、`PageSkeleton` 已接入；另包括调用页清理操作使用的
`ManagementTaskConfirmationDialog`）。范围按用户操作链路划分，不按共享组件所在目录划分；
只提取清理调用记录所需的确认文案，设置页的其他管理操作仍属延期的阶段三 B。
不进入翻译：拼接出的 Provider/模型/Thread/Turn ID、HTTP 方法与路径、WebSocket 地址、
请求/响应/日志正文、`[debug].model_traffic_dump`、`codexc traffic` 等配置或命令片段，以及
`{name}` 占位符的实际取值。`Turn State`、`instructions`、`Chat`、`WebSocket`、`Fast` 等产品与协议术语保留原样。
通用文案复用 `common.*`、`metrics.*`、`filters.*`、`pages.*`、`modelComparison.*` 与 `errors.*`；
本批新增键统一放在 `traffic.*`。

##### 复用现有键

| 键 | 中文 | 位置 | 场景 |
| --- | --- | --- | --- |
| `pages.traffic` | 调用详情 | traffic-page.tsx:105 | 列表页标题 |
| `pages.trafficDetail` | 调用明细 | traffic-page.tsx:67 | 详情页标题 |
| `common.refresh` | 刷新 | traffic-page.tsx:74、170 | 刷新按钮 |
| `common.refreshing` | 刷新中 | traffic-page.tsx:170 | 刷新中按钮文案 |
| `common.perPage` | 每页 | traffic-page.tsx:236 | 分页每页标签 |
| `common.previous` | 上一页 | traffic-page.tsx:263、traffic-detail.tsx:185 | 分页 |
| `common.next` | 下一页 | traffic-page.tsx:279、traffic-detail.tsx:196 | 分页 |
| `common.page` | 第 {page} 页 | traffic-page.tsx:274 | 分页 |
| `common.loading` | 加载中… | traffic-table.tsx:87 | 单元格加载 |
| `common.loadFailed` | 加载失败 | traffic-table.tsx:87 | 单元格失败 |
| `metrics.time` | 时间 | traffic-table.tsx:36 | 表格列 |
| `metrics.model` | 模型 | traffic-table.tsx:38 | 表格列 |
| `metrics.type` | 类型 | traffic-table.tsx:42 | 表格列 |
| `metrics.requests` | 请求 | traffic-table.tsx:43、traffic-request-content.tsx:47、traffic-detail.tsx:111 | 列/表头/卡片标题 |
| `metrics.input` | 输入 Token | traffic-detail.tsx:225 | 指标标签 |
| `metrics.output` | 输出 Token | traffic-detail.tsx:226 | 指标标签 |
| `filters.status` | 状态 | traffic-table.tsx:39 | 表格列 |
| `filters.response` | 响应 | traffic-detail.tsx:71、72、78 | 卡片标题与 aria-label |
| `modelComparison.notProvided` | 未提供 | traffic-request-content.tsx:52、53；traffic-detail.tsx:96、118、119、155、292、293 | 缺失值回退 |
| `requests.firstColumn` | 首 Token | traffic-detail.tsx:222 | 指标标签（文案与 requests 相同，建议复用） |
| `requests.durationColumn` | 请求耗时 | traffic-table.tsx:40、traffic-detail.tsx:223 | 列与指标（文案与 requests 相同，建议复用） |

##### 列表视图（traffic-page.tsx）

| 键 | 中文原文 | 占位符 | 位置 | 场景 |
| --- | --- | --- | --- | --- |
| `traffic.listIntro` | 记录的模型请求与响应字段；默认汇总全部提供商、全部保留批次，按请求时间倒序展示 | — | :107-108 | 列表说明；前缀内联配置片段不翻译 |
| `traffic.provider` | 提供商 | — | :115、traffic-detail.tsx:141 | 提供商筛选标签与记录字段标签（同一文案合并为一个键） |
| `traffic.allProviders` | 全部提供商 | — | :125、:217 | 筛选全选与范围显示 |
| `traffic.providerOption` | {label}（{sessions} 个批次） | label、sessions | :128 | 提供商选项 |
| `traffic.sessionFilterLabel` | 记录批次 | — | :138 | 批次筛选标签 |
| `traffic.allSessions` | 全部批次 | — | :150 | 批次全选 |
| `traffic.turnStatesError` | Turn State 字符数加载失败：{error} | error | :177 | 批次字符数加载失败（error 需结构化） |
| `traffic.clearScope` | 查看全部提供商和批次 | — | :185 | 出错后清除范围 |
| `traffic.dumpDisabledTitle` | 当前未开启调用详情记录 | — | :189 | 未开启转储标题 |
| `traffic.dumpDisabledDescription` | 配置里 {configKey} 关闭时不会再写入新记录，这里显示的是已存在的历史调用记录文件。 | configKey | :191-192 | 完整说明；仅配置键 `[debug].model_traffic_dump` 原样保留，“配置里”参与翻译；接入时保留配置键的 code 展示 |
| `traffic.limitTitle` | 已达到调用记录分页上限 | — | :198 | 分页上限标题 |
| `traffic.limitDescription` | 当前最多翻到 offset {offset}；仍有更早记录时，请选择单个记录批次缩小范围，或使用 {command} 查看。 | offset、command | :200-201 | 分页上限说明；命令 `codexc traffic` 原样保留并保持 code 展示 |
| `traffic.retentionNote` | 自动保留：{value}；App Server 启动及新记录批次建立时清理过期历史批次。 | value | :207-208 | 保留策略说明 |
| `traffic.retentionOff` | 已关闭 | — | :207 | 保留关闭取值 |
| `traffic.retentionDays` | {count} 天 | count | :207 | 保留天数取值 |
| `traffic.listRefreshing` | 正在刷新请求记录… | — | :215 | 列表刷新标题 |
| `traffic.listTitle` | 请求记录（{count}） | count | :215 | 列表卡片标题 |
| `traffic.allSessionsCount` | 全部 {count} 个保留批次 | count | :218 | 范围说明 |
| `traffic.sessionScope` | 批次 {name} | name | :218 | 范围说明 |
| `traffic.recordsTotal` | 条 · 共 {count} 条 | count | :256 | 分页计数 |
| `traffic.detailIntro` | 查看本次请求的结果、用量与诊断信息 | — | :69 | 详情页说明 |
| `traffic.backToList` | 返回列表 | — | :81 | 返回列表按钮 |

##### 调用表格（traffic-table.tsx）

| 键 | 中文原文 | 占位符 | 位置 | 场景 |
| --- | --- | --- | --- | --- |
| `traffic.turnStateColumn` | Turn State 字符数 | — | :41 | 表格列（术语保留） |
| `traffic.openDetailAria` | 查看 {provider} {time} 的调用明细 | provider、time | :66 | 行内链接 aria-label |
| `traffic.hasError` | 异常 | — | :80 | 错误徽章 |
| `traffic.turnStateHint` | {count} 字符 · {source} | count、source | :86 | 列提示（多来源用全角分号连接） |
| `traffic.categoryModels` | 模型列表 | — | :90、:59、:87 | 分类显示 |
| `traffic.categoryPrewarm` | 连接预热 | — | :90、:59、:87、:88 | 分类显示 |
| `traffic.categoryRequest` | 模型请求 | — | :90、:59 | 分类显示 |
| `traffic.empty` | 没有调用记录 | — | :98 | 空态 |
| `traffic.stateCompleted` | 完成 | — | :109、:210 | 状态（表格与徽章共享） |
| `traffic.stateFailed` | 失败 | — | :110、:210 | 状态 |
| `traffic.stateIncomplete` | 不完整 | — | :111、:210 | 状态 |
| `traffic.statePending` | 未记录终态 | — | :112、:211、:73 | 状态与空态标题 |

##### 内容折叠与复制（traffic-content.tsx）

| 键 | 中文原文 | 占位符 | 位置 | 场景 |
| --- | --- | --- | --- | --- |
| `traffic.copyRaw` | 复制原文 | — | :33 | 复制按钮 |
| `traffic.wrap` | 自动换行 | — | :34 | 换行切换按钮 |
| `traffic.format` | 格式化 | — | :35 | 格式化切换按钮 |
| `traffic.copiedRaw` | 已复制原文 | — | :36 | 复制成功状态 |
| `traffic.copyFailedBody` | 复制失败，请手动选择正文复制。 | — | :36 | 复制失败状态 |
| `traffic.truncatedNote` | 内容已截断，展示和复制均仅包含已保留片段。 | — | :38 | 截断说明 |
| `traffic.emptyContent` | （空） | — | :39 | 空内容占位 |

##### 请求内容（traffic-request-content.tsx）

| 键 | 中文原文 | 占位符 | 位置 | 场景 |
| --- | --- | --- | --- | --- |
| `traffic.instructionsTitle` | 顶层指令（instructions） | — | :9 | 折叠标题（术语保留） |
| `traffic.requestInputAria` | 请求输入 | — | :13 | 区块 aria-label |
| `traffic.requestInputTitle` | 请求输入（调用记录保留内容） | — | :14 | 区块标题 |
| `traffic.inputMissing` | 未提取到输入，见原始正文。 | — | :15 | 空态 |
| `traffic.inputEmpty` | 输入为空。 | — | :16 | 空态 |
| `traffic.inputContentTitle` | 输入内容 | — | :22 | 内容标题 |
| `traffic.toolsMissing` | 未提取到工具清单。 | — | :26 | 空态 |
| `traffic.toolsTitle` | 声明工具（{count} 项，非实际调用） | count | :27 | 折叠标题 |
| `traffic.toolDefinitionTitle` | 工具定义 | — | :31 | 内容标题 |
| `traffic.parameterComparisonTitle` | 参数对照（请求 / 响应回报） | — | :44 | 折叠标题 |
| `traffic.parameterComparisonNote` | 响应回报值不代表模型内部实际执行情况；缺失或 null 均标为未提供。 | — | :45 | 说明 |
| `traffic.fieldColumn` | 字段 | — | :47 | 表头 |
| `traffic.responseReportedColumn` | 响应回报 | — | :47 | 表头 |
| `traffic.inputOmitted` | 已省略 {count} 条输入，正文未保存 | count | :63 | 输入条目标签 |
| `traffic.unknownCount` | 未知数量 | — | :63 | 数量回退 |
| `traffic.inputTruncated` | 已截断条目（仅保留头尾） | — | :64 | 输入条目标签 |
| `traffic.inputToolOutput` | 工具结果 | — | :65 | 输入条目标签 |
| `traffic.inputToolCall` | 历史工具调用 | — | :66 | 输入条目标签 |
| `traffic.roleUser` | 用户输入 | — | :68 | 消息角色 |
| `traffic.roleDeveloper` | 开发者指令 | — | :68 | 消息角色 |
| `traffic.roleSystem` | 系统指令 | — | :68 | 消息角色 |
| `traffic.roleAssistant` | 历史助手消息 | — | :68 | 消息角色 |
| `traffic.roleUnknown` | 消息（角色未提供） | — | :69 | 角色回退；未知角色保留原值 |
| `traffic.instructionsContentTitle` | 指令内容 | — | :75 | 内容标题 |

##### 调用详情（traffic-detail.tsx）

| 键 | 中文原文 | 占位符 | 位置 | 场景 |
| --- | --- | --- | --- | --- |
| `traffic.overviewAria` | 调用概览 | — | :55 | 卡片 aria-label |
| `traffic.refreshingTrace` | 正在刷新调用记录，当前摘要为上次成功读取的内容。 | — | :69 | 刷新状态 |
| `traffic.noTerminalDescription` | 当前记录没有终态响应，无法据此判断请求是否仍在运行。可刷新查看。 | — | :73 | 空态说明 |
| `traffic.savedResponse` | 已保存的响应内容 | — | :79 | 描述回退 |
| `traffic.outputMissing` | 未提取到输出 | — | :87 | 空态标题 |
| `traffic.prewarmNoOutput` | 本次请求不生成回答。 | — | :88 | 空态说明 |
| `traffic.outputEmptyHint` | 可展开原始响应查看已保存的内容。 | — | :88 | 空态说明 |
| `traffic.outputTruncatedTitle` | 输出展示不完整 | — | :92 | 警告标题 |
| `traffic.outputTruncatedDescription` | 输出超出展示上限，或传输记录残缺、无法解析。原始调用记录未被修改。 | — | :92 | 警告说明 |
| `traffic.responseRawTitle` | 响应头与原始响应 | — | :94 | 折叠标题 |
| `traffic.truncatedSuffix` | · 展示已截断 | — | :94 | 响应标题截断后缀（自带连接符） |
| `traffic.truncatedSuffixParen` | （展示已截断） | — | :123 | 请求标题截断后缀（自带全角括号，英文用半角） |
| `traffic.responseServiceTier` | 响应服务层级：{value} | value | :96 | 字段 |
| `traffic.responseId` | 响应 ID：{id} | id | :98 | 字段 |
| `traffic.transferred` | 传输 {size} | size | :100 | 响应字节信息 |
| `traffic.stored` | 存储 {size} | size | :100、:128 | 字节信息 |
| `traffic.responseHeadersTitle` | 响应头 | — | :101 | 表标题 |
| `traffic.responseBodyRawTitle` | 原始终态 | — | :102 | 内容标题 |
| `traffic.reasoningEffort` | 思考等级：{value} | value | :118 | 字段 |
| `traffic.requestServiceTier` | 请求服务层级：{value} | value | :119 | 字段 |
| `traffic.noOutputBadge` | 不生成输出 | — | :120 | 徽章 |
| `traffic.requestRawTitle` | 请求头与原始正文 | — | :123 | 折叠标题 |
| `traffic.previousResponseId` | 接续响应：{id} | id | :126 | 字段 |
| `traffic.requestBytesRaw` | 原始 {size} | size | :128 | 请求字节信息 |
| `traffic.requestHeadersTitle` | 请求头 | — | :129 | 表标题 |
| `traffic.requestBodyTitle` | 请求正文 | — | :130 | 内容标题 |
| `traffic.diagnosticsTitle` | 诊断信息 | — | :136、:137 | 卡片标题与 aria-label |
| `traffic.diagnosticsDescription` | 记录定位、模型声明与原始事件，按需展开。 | — | :137 | 卡片说明 |
| `traffic.recordInfoTitle` | 记录信息 | — | :139 | 折叠标题 |
| `traffic.fieldSession` | 批次 | — | :141 | 记录字段标签 |
| `traffic.fieldCallId` | 调用编号 | — | :141 | 记录字段标签 |
| `traffic.fieldThread` | 会话 | — | :141 | 记录字段标签 |
| `traffic.fieldTurn` | 轮次 | — | :141 | 记录字段标签 |
| `traffic.fieldRequestKind` | 请求类型 | — | :141 | 记录字段标签 |
| `traffic.fieldTransport` | 传输 | — | :141 | 记录字段标签 |
| `traffic.copyReference` | 复制定位信息 | — | :146 | 按钮 |
| `traffic.referenceCopied` | 已复制 | — | :147 | 状态 |
| `traffic.referenceCopyFailed` | 复制失败，请手动选择记录信息。 | — | :147 | 状态 |
| `traffic.postCompleteDiagnosticsTitle` | 完成后的诊断信息 | — | :150 | 折叠标题 |
| `traffic.postCompleteDiagnosticsNote` | 已记录完成终态；以下信息不改变本次请求的完成状态。 | — | :151 | 说明 |
| `traffic.chatUpstreamTitle` | Chat 上游信息 | — | :154 | 折叠标题（术语保留） |
| `traffic.chatUpstreamSummary` | 实际上游：{provider} · 上游模型：{model} | provider、model | :155 | 摘要 |
| `traffic.chatUpstreamNote` | 上游回报的路由、标识和费用；不同费用字段保持各自口径，不代表套餐实际扣费。备用提供商不代表已调用。 | — | :156 | 说明 |
| `traffic.chatUpstreamFieldsTitle` | 上游诊断字段 | — | :157 | 内容标题 |
| `traffic.chatUpstreamTruncated` | 部分诊断字段超出限制或格式无效，未保留。 | — | :158 | 说明 |
| `traffic.modelEvidenceTitle` | 模型声明与来源 | — | :161 | 折叠标题 |
| `traffic.traceTitle` | 原始事件（{count} 条） | count | :164 | 折叠标题 |
| `traffic.traceLoading` | 正在加载原始事件… | — | :166 | 加载态 |
| `traffic.traceError` | 原始事件加载失败，请重试。 | — | :166 | 失败态 |
| `traffic.traceRetry` | 重试原始事件 | — | :166 | 重试按钮 |
| `traffic.traceRange` | 当前 {from}–{to} / {total} 条 | from、to、total | :166 | 分页范围 |
| `traffic.truncatedInline` | （已截断） | — | :169 | 事件行后缀 |
| `traffic.traceItemTitle` | 事件正文 | — | :171 | 内容标题 |
| `traffic.firstTokenHint` | 提交发送至收到首段非空内容，含思考、正文或工具参数；缺失不补算。 | — | :222 | 指标提示 |
| `traffic.durationHint` | 提交发送至请求结束；不含发送前准备和客户端显示。 | — | :223 | 指标提示 |
| `traffic.cachedTokens` | 缓存 {count} · {rate} | count、rate | :225 | 输入指标说明 |
| `traffic.reasoningTokens` | 其中推理 {count} | count | :226 | 输出指标说明 |
| `traffic.responseIncomplete` | 响应不完整 | — | :242 | 失败标题 |
| `traffic.requestFailed` | 请求失败 | — | :242 | 失败标题 |
| `traffic.failureStage` | 失败阶段：{stage} | stage | :244 | 字段 |
| `traffic.failureUnknown` | 记录未提供具体原因。 | — | :246 | 失败说明 |
| `traffic.errorDetailsTitle` | 错误详情 | — | :247 | 折叠标题 |
| `traffic.rawDiagnosticsTitle` | 原始诊断 | — | :257 | 内容标题 |
| `traffic.outputCommentary` | 过程说明 | — | :261 | 输出标签 |
| `traffic.outputAnswer` | 回答 | — | :261 | 输出标签 |
| `traffic.outputReasoning` | 推理摘要 | — | :262 | 输出标签 |
| `traffic.outputToolCall` | 工具调用：{name}{id} | name、id | :264 | 输出标签 |
| `traffic.unknownName` | 未提供名称 | — | :264 | 名称回退 |
| `traffic.modelEvidenceNote` | 仅比较请求与响应回显名称，不验证模型身份。缺失不代表上游未发送。 | — | :291 | 说明 |
| `traffic.requestModel` | 请求模型：{name} | name | :292 | 字段 |
| `traffic.responseModels` | 响应回显：{names} | names | :293 | 字段 |
| `traffic.serverModelsTitle` | 服务端模型声明（不覆盖响应回显）： | — | :294 | 小节标题 |
| `traffic.notRecorded` | 未记录 | — | :295、:297、:299 | 空态 |
| `traffic.modelWithSource` | {model} · 来源：{source} | model、source | :295、:297 | 条目 |
| `traffic.safetyModelsTitle` | 安全缓冲候选声明（不表示已经切换，也不表示由该模型执行安全检查）： | — | :296 | 小节标题 |
| `traffic.turnStateLengthsTitle` | X-Codex-Turn-State 字符数： | — | :298 | 小节标题（协议头名保留） |
| `traffic.turnStateWithSource` | {count} 字符 · 来源：{source} | count、source | :299 | 条目 |
| `traffic.modelEvidenceTruncated` | 声明展示不完整：超过条数或字段长度限制，或含无效字符。 | — | :300 | 说明 |

##### 清理控件（traffic-cleanup-controls.tsx）

| 键 | 中文原文 | 占位符 | 位置 | 场景 |
| --- | --- | --- | --- | --- |
| `traffic.cleanupAction` | 清空调用记录 | — | :34 | 清理按钮 |
| `traffic.retryTasks` | 重试读取任务 | — | :38 | 任务读取失败重试 |
| `traffic.taskCompleted` | 清理完成 | — | :45 | 任务状态 |
| `traffic.taskFailed` | 清理失败 | — | :46 | 任务状态 |
| `traffic.taskCancelled` | 已取消 | — | :47 | 任务状态 |
| `traffic.taskCancelling` | 取消中 | — | :48 | 任务状态 |
| `traffic.taskQueued` | 等待清理 | — | :49 | 任务状态 |
| `traffic.taskRunning` | 清理中 | — | :49 | 任务状态 |

##### 调用记录清理确认（共享 management-task-controls.tsx）

以下为调用页清理入口实际使用的确认内容，不代表启动设置页国际化。本批已接入对应中英文，
保留预览、一次性确认、任务提交及禁用规则；不扩展到服务、指标库或更新源码等其他任务。

| 键 | 中文原文 | 占位符 | 位置 | 场景 |
| --- | --- | --- | --- | --- |
| `traffic.cleanupConfirmTitle` | 确认执行管理任务 | — | management-task-controls.tsx:83 | 清理确认标题 |
| `traffic.cleanupConfirmDescription` | 确认后提交后台任务，任务将在服务端串行执行。 | — | :83 | 确认说明 |
| `traffic.cleanupConfirmAction` | 确认执行 | — | :83 | 显式确认按钮 |
| `traffic.cleanupOperation` | 操作：{operation} · {action} | operation、action | :71 | 操作标识原样保留 |
| `traffic.cleanupTarget` | 目标：{target} | target | :72 | 可选目标字段；当前清理任务无目标，不构造目标 |
| `traffic.cleanupPrecondition` | 前置条件：{condition} | condition | :74 | 前置条件标签；condition 为服务端生成文案，见下表 |
| `traffic.cleanupRecovery` | 失败处理：{recovery} | recovery | :75 | 失败处理标签；recovery 为服务端生成文案，见下表 |
| `traffic.cleanupResourceRunning` | 将删除 {sessions} 个 V2 批次、{files} 个旧版文件，合计 {size}；受管 App Server 当前仍在运行。 | sessions、files、size | :85-87 | 资源摘要；App Server 运行时确认被禁用 |
| `traffic.cleanupResourceStopped` | 将删除 {sessions} 个 V2 批次、{files} 个旧版文件，合计 {size}；受管 App Server 当前未运行。 | sessions、files、size | :85-87 | 资源摘要；使用完整句子避免拼接状态片段 |

底层 `ManagementConfirmationDialog` 已使用 `accountConfirmation.cancel`、`accountConfirmation.processing`、
`accountConfirmation.refreshing` 和 `common.loading`，取消、提交中、刷新中与 Spinner 名称复用已有翻译。
`traffic-cleanup-controls.tsx:33` 的清理按钮 Spinner 已传入 `common.loading`。

清理预览还直接展示服务端生成的以下中文。它们是界面说明，不是原始调用正文，不能按日志豁免翻译：

| 拟用键 | 中文原文 | 占位符 | 来源与消费位置 |
| --- | --- | --- | --- |
| `traffic.cleanupEffect` | 执行 {command} | command | scripts/webui-management-tasks.mjs 的 preview.effects → management-task-controls.tsx:73；command 固定为原样保留的 `codexc traffic cleanup --confirm` |
| `traffic.cleanupStoppedRequired` | 全部 App Server 必须已停止 | — | preview.preconditions → :74 |
| `traffic.cleanupIrreversible` | 永久删除全部可识别调用记录，无法恢复；未知文件与目录不处理 | — | preview.recovery → :75 |

这些服务端字段当前是字符串。本批仅在清理调用记录分支精确映射上述受控文案，
未知预览文案原样保留，避免遗漏确认信息；不将任意文本作为字典键，不改写命令或停止检查。
回归使用真实任务 preview 产物验证映射，后续服务端改词时须同步映射及测试。
`preview.activation` 的“不会自动启动已停止的 App Server”未由此弹窗渲染，不作为本弹窗新增展示内容。

##### 本批状态

- 中文提取与组件接入：已完成本批范围，清单见上，复用键已标注，新增键统一在 `traffic.*`；实现中还补齐了配置说明前缀
  与 `previousResponseId`。
- 场景覆盖：加载、空态、失败、重试、展开、复制、分页、工具提示与卡片/区块无障碍名称。
- 英文：由执行模型直接生成。2026-09-27 用户明确要求“直接提取翻译、不调用”，据此跳过外部翻译服务，
  未调用任何真实服务，这些英文不是 CI 自动翻译产物，也不再等待自动翻译流程。本批最初新增 151 个
  `traffic.*` 键，中文源与英文同时写入 `messages.ts`，键与占位符一致。
- 英文候选位于 `messages.ts` 的 `en.traffic`；上表为中文提取清单，不是英文复核稿。
  完整视觉与真实浏览器交互验收仍待补充。
- 组件接入：`pages/traffic-page.tsx`、`components/traffic/`（表格、详情、内容折叠、请求内容、清理控件）
  已接入双语；列表与详情查询失败改用结构化错误码加通用提示，`Spinner` 传入本地化 `aria-label`。
  i18n 测试以真实组件在英文下渲染调用页（列表、未开启记录、分页上限、详情）与表格、详情各态，
  并断言无中文字符。
  审查修复已补齐清理确认分支及其受控预览文案，保持 App Server 运行时禁用确认的规则；
  设置页其他管理操作不扩展。Turn State 失败摘要保存批次标识，逐行失败保存错误码，渲染时翻译；
  清理失败未知消息使用通用提示，不回显内部异常。
  修复后相关四组回归共 69 项通过，字典键与占位符校验通过（457 个中文源键）；
  WebUI 类型检查、构建、Lint、测试文件 Lint 和文档检查通过。

##### 尚未处理的边界

- 未识别的清理预览文案原样显示，确保确认信息完整；服务端添加新说明时需同步受控映射。
- 数字目前不跟随界面语言：`traffic-page.tsx:200`、`traffic-table.tsx:86`、`:87`、`traffic-detail.tsx:299`
  使用 `toLocaleString("zh-CN")`，`traffic-detail.tsx:225`、`:226` 使用无参数 `toLocaleString()`（跟随浏览器默认区域）。
  接入批应改为按显示语言复用统一格式化函数；整数在 zh-CN 与 en-US 下分组一致，实际视觉影响较小。
- 设置页的 `Spinner` 调用点仍待其阶段处理；调用页的 `Spinner` 已传入本地化名称。
- `requests.firstColumn`（首 Token）与 `requests.durationColumn`（请求耗时）与本批文案相同；
  当前清单按复用处理，若评审要求保留独立命名空间，改为新增 `traffic.*` 键。
- 真实浏览器的窄屏、键盘、悬浮与视觉检查未进行。

阶段三 B 设置页按用户要求暂不处理，原因是页面还会调整。字段说明、输入校验、操作预览、
确认按钮、执行状态、取消与失败提示留待用户明确恢复后再规划；已有共享组件翻译不回退。
将来恢复时，仍须保证语言切换不重新提交操作、不清空草稿、不关闭待处理确认、不改变授权范围。

### 阶段四：整体验收

按页面记录覆盖结果。仅当全部业务页面完成时，才把用户文档更新为全 WebUI 覆盖。
检查中文和英文下的桌面、窄屏、菜单、弹窗、错误、加载和空状态；键盘与辅助技术获得的名称也应一致。
新增页面或公共组件沿用同一字典和验收标准，不依赖运行时 DOM 文本替换来补翻译。

## 验证与交付

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
普通提交通过现有提交钩子执行完整 `verify:commit`，开发阶段按实际改动选择检查，不重复运行全量门禁。

阶段一验证记录：相关测试 46 项通过，类型、Lint、WebUI 构建和文档检查通过；
使用临时 DOM 环境挂载真实 React 组件，验证语言菜单、Threads 表头与空状态、页面 `lang`、
偏好保存与重新挂载恢复，以及登录失败提示随语言变化。该临时交互验证未新增项目依赖，
不属于仓库常驻测试，也不能替代真实浏览器的窄屏和视觉检查；后者仍待补充。

阶段二 A 首轮验证记录（确认弹窗修复前）：字典新增控制台与概览文案，`i18n:check` 通过（234 个中文源键，中英文键与占位符一致），
差异报告 `--base HEAD` 列出 96 个新增键、无结构问题；相关 12 个测试文件共 192 项通过
（含 `webui-i18n`、`webui-tables`、`webui-account-refresh-state`、`webui-overview-state`、
`webui-server-provider-management`、`gateway-account-refresh` 与 `surface-copy-contract`），
WebUI 构建、WebUI Lint、仓库 Lint 与 `docs:check` 通过。i18n 测试以真实组件在
英文下渲染控制台的加载、成功、无账户、查询错误、账户列表错误、删除提示与订阅状态，断言这些状态无中文字符。
审查发现并已修复两处：控制台、登录页与共享表格的 `Spinner` 由调用方传入 `aria-label`
（不改动 `components/ui/`，沿用其属性透传），账户列表与快照读取失败改为按错误码本地化，
不再显示原始 API 文案。测试同时覆盖 Threads 表格加载态，防止可访问名称回退为中文。
真实浏览器的窄屏、键盘与视觉检查仍未进行。

阶段二 A 审查补充：控制台删除账户链路现已覆盖二次确认弹窗，包括不可恢复的历史 Thread 警告、
订阅说明、预览字段标签，以及共享确认控件的取消、确认、刷新和处理状态；账户名称、操作标识、
配置值、影响字段与生效目标保留原值。复用这些控件的设置页同步获得对应翻译，设置页其余业务文案仍在阶段三。
补充回归覆盖英文待确认、刷新与提交状态及按钮禁用规则；相关三组测试共 50 项通过。
修复后 `i18n:check` 通过（257 个中文源键），WebUI 构建、前后端 Lint 与文档检查通过。
临时 DOM 验证中，同一个已挂载弹窗从中文切到英文再切回，保持弹窗与预览内容，
没有触发取消或提交，显式点击确认仅调用一次；未新增项目依赖，不替代真实浏览器检查。

阶段二 A 已记录、尚未处理的边界：

- 网关生成的账户文案（账户来源告警 `warning.message`、单账户刷新提示、订阅卡片复用的账户设置错误）
  仍是中文，英文界面会原样显示。要本地化需让私有 IPC 与 HTTP 错误体携带受控 `reason`，再由 WebUI 映射；
  这会改动 `runtime/gateway-account-refresh.mjs`、`scripts/webui-management-provider-route.mjs`、
  WebUI API 客户端及其合同测试，超出本批 WebUI 展示层范围，需单独授权后再做。
- 配额窗口标签由 WebUI 按稳定 `windowId` 映射，未知窗口回退到服务端标签；服务端改词或新增窗口时回退值可能为中文。
- `Spinner` 的默认可访问名称仍为中文；控制台、登录页与共享表格已传入本地化 `aria-label`，
  调用详情与设置页的调用点留在各自阶段按同一方式处理。

阶段二 B 验证记录（请求与错误）：先核对中文源文案并提取字典，范围是
`pages/requests-page.tsx`、`pages/errors-page.tsx`、`components/requests/requests-table.tsx`，
以及错误列表直接使用的 `FastBadge`、`StatusBadge` 与 `TrafficModel`。表头、提示、空状态、分页、
导出按钮与错误分类复用已有 `metrics.*`、`filters.*`、`common.*` 键；把控制台错误摘要的
“没有异常请求”移动到 `common.noFailedRequests`，消除同一文案的两处来源。请求、错误查询与导出失败
改为按结构化错误码翻译：`useRequests`、`useErrors` 转出 `errorCode`，`useMetricsExport` 只返回
`failed` 与 `errorCode`，不再把原始异常正文当作界面文案。

保留请求/响应模型对照、Fast 层级、错误类型与错误消息翻译、Thread/Turn 关联链接、分页与筛选取值、
表格列可见性存储键；模型对照列表分隔符改为按语言的列表分隔键，中文输出不变。请求明细表的表格内
筛选入口没有调用方，已删除 `requests.filterPlaceholder`、`requests.filterHint` 两个不会被渲染的键与
`RequestsTable` 的 `onFilterChange` 透传，避免留下死键；请求页继续使用页面筛选栏。
`i18n:check` 通过（293 个中文源键，中英文键与占位符一致）；差异报告 `--base HEAD` 为
37 个新增键、1 个移除键、无结构问题；`webui-i18n`、`webui-i18n-tool`、`webui-tables`、
`webui-traffic-state`、`webui-settings-presentation`、`webui-account-refresh-state`、
`webui-overview-state`、`webui-server-data-api` 与 `surface-copy-contract` 测试共 149 项通过，
WebUI 构建、WebUI Lint、仓库 Lint 与 `docs:check` 通过。i18n 测试以真实组件在英文下渲染
请求明细表（有数据、空、加载）、请求页、错误页（有数据、加载、空、失败），断言无中文字符。

阶段二 B 审查补充：导出链路将网络失败与超时分别映射为 `network_error`、`request_timeout`，
复用现有中英文提示；API 错误保留结构化错误码，其他未知异常继续使用通用提示。
新增回归执行生产导出 Hook（内存状态替身与隔离网络），覆盖网络、超时、API 和未知异常、
重试清除旧错误及 pending 复位；`webui-i18n` 共 13 项测试通过。
临时 DOM 中另行挂载真实 Hook，验证网络失败与超时返回对应分类，无新增项目依赖。

阶段二 B 已记录、尚未处理的边界：

- `runtime/model-name-comparison.mjs` 返回受控中文对照值，WebUI 映射到字典键并对新增取值回退原值；
  改为返回稳定代码会同时改动 CLI 文案与测试，超出本批展示层范围。
- `TableHint` 与工具提示内容不在服务端渲染输出中，本批对错误码等提示文案仅做了字典键断言，
  真实浏览器悬浮与焦点检查仍待补充。
- 请求页使用页面筛选栏；共享表格仅在调用方传入 `onFilterChange` 时渲染表格内筛选输入，
  请求页不使用该入口，表格内筛选的真实行为未在浏览器中验证。
- 真实浏览器的窄屏、键盘与视觉检查未进行；调用详情的 `Spinner` 已传入本地化名称，设置页的调用点留在其阶段。

交付时更新本页阶段状态、实际验证结果及缺失检查，并同步 [`webui.md`](webui.md) 的用户可见范围。
需要新增国际化或测试依赖时，先说明必要性与影响，遵循项目依赖授权规则；不为后续未实施阶段提前引入依赖。
