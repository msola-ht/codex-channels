# 本地指标 WebUI

`codexc webui` 启动本地指标 WebUI，展示模型请求指标数据库（`request-metrics.sqlite3`）中的全局统计、
会话、请求明细与错误聚合；设置页还可修改结构化配置，并通过白名单异步任务执行受保护的服务与维护动作。回环监听未配置令牌时复用真实回环连接与 Origin 约束；配置令牌或绑定非回环地址时使用同一令牌鉴权。WebUI 不读取业务会话库，不接受任意命令。
“转储”页另有一份只读视图，展示 `[debug].model_traffic_dump` 落盘的模型请求与响应原文，只对回环连接开放。

## 命令

```text
codexc webui [--host 127.0.0.1|::1|0.0.0.0] [--port 端口]
```

参数优先级：命令行 > `config.toml` 的 `[webui]` 段 > 默认值（`127.0.0.1:8787`）。

- 默认监听 `127.0.0.1:8787`，无令牌即可访问；
- `--host 0.0.0.0` 绑定所有网卡（局域网/公网/Tailscale 直连）；此时必须提供 `--token`，
  API 使用 `Authorization: Bearer <令牌>` 校验，缺少令牌会拒绝启动；
- `config.toml` 示例：

```toml
[webui]
host = "127.0.0.1"   # 127.0.0.1 / ::1 仅本机；0.0.0.0 必须设置 token
port = 8787
token = "你的_访问令牌"
```

也可以运行 `codexc config` 选择「WebUI 设置」交互修改以上三项，效果等价。
- 前端在 API 返回 401 时显示令牌输入页；也可以通过
  `http://<地址>:<端口>/?token=<令牌>` 直接携带令牌打开（令牌会出现在浏览器历史，谨慎使用）。

## 访问方式

单实例绑定一个端口即可同时支持以下入口，不需要多开进程：

| 方式 | 服务器绑定 | 令牌 | 典型命令 |
| --- | --- | --- | --- |
| 本机浏览器 | `127.0.0.1` | 不需要 | `codexc webui` |
| SSH 隧道 | `127.0.0.1`（或 `0.0.0.0` 经回环转发） | 绑定 `0.0.0.0` 时需要 | 本机执行 `ssh -L 8787:127.0.0.1:8787 user@服务器`，再访问 `http://127.0.0.1:8787/` |
| 反向代理 | `127.0.0.1` | 不需要（反代层鉴权） | Nginx/Caddy `proxy_pass http://127.0.0.1:8787` |
| Cloudflare Tunnel | `127.0.0.1` | 不需要（Cloudflare Access） | `cloudflared tunnel --url http://127.0.0.1:8787` |
| 局域网直连 | `0.0.0.0` | 需要 | 先运行 `codexc config` 设置 WebUI 令牌，再运行 `codexc webui --host 0.0.0.0`，访问 `http://<局域网IP>:8787/?token=令牌` |
| 公网直连 / Tailscale 直连 | `0.0.0.0` | 需要 | 同上，地址换成公网 IP 或 Tailscale IP |

- SSH 隧道、反向代理与 Cloudflare Tunnel 都连接服务器的回环地址；绑定 `127.0.0.1` 时可以保持无令牌，
  认证由 SSH、反代层或 Tailnet ACL 负责。绑定 `0.0.0.0` 时仍需 WebUI 令牌，但设置管理只接受这类回环连接；
- 只有直接绑定 `0.0.0.0`（局域网、公网、Tailscale IP 直连）才必须设置令牌；
- 所有入口共用一个实例与端口，配置一次 `[webui]` 后各方式同时生效。

设置管理的 Origin 只接受 HTTP 回环主机 `127.0.0.1`、`localhost` 或 `[::1]`，SSH 隧道的本机
转发端口可以与服务器监听端口不同；不会从 `Host`、`X-Forwarded-Host` 或其他转发头扩信任。
SSH 隧道建议统一使用 `127.0.0.1`，不要用服务器公网 IP、Tailscale IP 直连管理接口。

## 后台服务

WebUI 是独立后台服务，不并入 `all`：`codexc service install` 只生成服务单元并启动 App Server
与 Gateway，需要后台常驻时单独管理：

```bash
codexc service start webui       # 启动
codexc service status webui      # 查看状态
codexc service logs webui -n 100 # 查看日志
codexc service restart webui     # 重启
codexc service stop webui        # 停止
```

- Linux 使用 systemd 用户服务 `codex-connect-webui.service`，macOS 使用 launchd
  `com.hegenai.codex-webui`；`codexc service uninstall` 会一并卸载；
- 服务单元固定运行 `codexc webui`，host/port/token 全部来自 `config.toml` 的 `[webui]` 段；
- 指标库升级到新 Schema 后运行 `codexc update` 统一预检和迁移，否则 API 会因版本不兼容报错。

## 页面与 API

控制台会话卡片的主数显示会话数，副标题显示轮次，跟随汇总时间范围，与 Threads 列表使用相同计数：只统计期间有
Thread 和 Turn 归属的请求，会话按 Thread 去重，轮次按 Thread + Turn 去重；同一轮的多次请求
只计一轮，子代理作为独立会话计入。这是本机指标库观测到的轮次，不代表完整官方会话历史。
`/api/v1/overview` 通过 `threadCount`、`turnCount` 返回这两个计数。
“按 Provider”表格及 `providers[]` 同样提供 `threadCount`、`turnCount`，按所选时间范围内该
Provider 的请求独立去重。跨 Provider 的同一会话或轮次会分别计入对应行，行间相加不代表全局去重总数；
表格中的会话、轮次与请求数均显示精确整数。

| 页面 | 路由 | API |
| --- | --- | --- |
| 概览 | `#/` | `GET /api/v1/overview?range=<范围>`、`GET /api/v1/daily?range=<范围>` |
| Threads | `#/threads` | `GET /api/v1/threads?range=&offset=&limit=&sort=&direction=`（包含期间首个匹配请求的开始时间） |
| Thread 详情 | `#/threads/:id` | `GET /api/v1/threads/:id/run`、`GET /api/v1/threads/:id/turns` |
| 请求明细 | `#/requests` | `GET /api/v1/requests?range=&offset=&limit=&sort=&direction=` |
| 请求导出 | 请求页按钮 | `GET /api/v1/requests/export`（同样的筛选条件，导出全部匹配请求为 JSON） |
| 转储 | `#/traffic` | `GET /api/v1/traffic?label=&session=&offset=&limit=`（摘要，默认 100、上限 500）、`GET /api/v1/traffic/exchange?id=&label=&session=&frameOffset=`（单条字段及 WebSocket 帧分页） |
| 错误 | `#/errors` | `GET /api/v1/errors?range=&offset=&limit=` |
| 设置 | `#/settings` | `GET /api/v1/settings/summary`（脱敏配置摘要）、`GET /api/v1/management/services`（服务状态、版本和未运行时的最近错误）、`GET /api/v1/management/upstream-user-agent`（模型上游实际 User-Agent 与取值来源）、`GET /api/v1/management/providers`（Provider 安全概览）、`/api/v1/management/settings`（Gateway 设置）、`/api/v1/management/codex/settings`（App Server 用户设置读取/预览/修改）、`/api/v1/management/provider-settings`（主 Provider、托管 Provider 默认值和共享子代理设置读取/预览/确认写入）、`/api/v1/management/account-settings`（OpenCode Go 多账户和 DeepSeek 配置读取/预览/确认写入）、`/api/v1/management/tasks`（白名单服务/指标/更新任务） |
| 本地账户与额度 | — | `GET /api/v1/accounts`（读取 Gateway 写入的统一账户快照）；`POST /api/v1/management/accounts/refresh`（按 Provider 请求 Gateway 实时刷新） |

指标接口只接受 GET；`/api/v1/daily` 按 `range` 返回本地指标库的 UTC 日聚合，供控制台热力图和趋势图使用。设置管理接口使用 GET 读取服务与配置，并仅以明确的 JSON POST/PATCH/DELETE 执行预览、写入和任务取消。管理请求始终要求真实回环连接和回环 Origin；WebUI 配置了令牌时还必须通过同一 Bearer 令牌鉴权。服务状态只读取平台服务管理器和受管运行日志（Linux 使用用户级 journald，macOS/Windows 使用私有错误日志）；高风险操作使用预览、一次性确认和白名单异步任务，仍不接受任意命令。

转储页读取用户数据目录 `traffic/` 下 `[debug].model_traffic_dump` 生成的 JSON Lines，默认展示最新
标签；标签、writer session、选中的 exchange 编号、页码与每页条数（25/50/100/200）都保留在页面地址中，刷新或分享
链接可回到同一条记录。摘要表只显示编号、时间、路径或 WebSocket URL、线程、轮次、请求类型、请求模型
与响应模型、状态；点开某条后列表收起、只显示该条的请求头、请求体、响应头、SSE 事件或 WebSocket
双向帧，「返回列表」回到原来的标签与页码。正文按原样显示；转储按
[`转储体积控制`](user-guide.md#转储体积控制) 裁剪过的条目会直接显示
`{"type": "truncated", …}` / `{"type": "omitted", …}` 标记。HTTP 请求体、响应体或单个 WebSocket 帧超过
4 MiB 时只返回前 4 MiB；WebSocket 帧页同时限制为 4 MiB、最多 100 帧，并通过 `framePage` 返回总数与
前后页 offset，页面可继续翻阅。HTTP 响应通过 `bodyTruncated` 标明截断。`label` 只接受 `traffic/`
中已存在的标签，`session` 只接受该标签下
实际存在的 writer session；非法或无来源的取值分别返回 400 与 404。目录中还没有转储文件、或请求不来自回环地址时返回 503，响应里的 `enabled` 表示
`[debug].model_traffic_dump` 当前是否开启。
控制台、请求、错误、Threads 和每轮明细共用时间选择器：今天、昨天、最近 7 天、最近 30 天、
全部历史、自定义日期。今天为服务端本地当天 00:00 至当前时刻，昨天为前一完整自然日，
对应 `range=today|yesterday`；滚动范围为 `7d|30d`，全部历史为 `all`。
自定义日期对应 `from=YYYY-MM-DD&to=YYYY-MM-DD`，必须同时提供且不得与 `range` 混用。
控制台自定义日期在点击“查询”后生效，Token、会话、轮次及趋势图使用同一所选范围；热力图仍固定最近 90 天。
同一页面会话内切换到其他页面再返回控制台时，保留已应用的范围并重新查询；未提交的自定义日期不保留。
切换范围或手动刷新时，只展示本轮加载返回的结果，不混用上一轮概览与趋势；重新加载整个 WebUI 后恢复默认最近 30 天。
OpenAI 周额度使用本轮概览独立展示，不因趋势加载失败而隐藏已返回的额度。
既有 API 的 `24h`、`90d` 查询继续支持，但不列在时间选择菜单中。
日期按 WebUI 服务所在主机本地时区解析，包含结束日并截断到当前时刻。
Threads 和每轮明细默认全部保留历史，控制台、请求和错误页面默认最近 30 天。分页 `offset` 从 0 开始，
`limit` 为 1–500。请求排序 `direction` 支持 `asc|desc`，`sort` 支持 `time`、`provider`、
`model`、`operation`、`status`、`http`、`error`、`input`、`output`、`reasoningOutput`。
已删除的 `speed`、`ttft`、`duration` 不再接受，传入时返回 400。
默认按 `time desc` 查询整个时间范围后再分页。请求接口
还支持 `filter` 关键字（最多 128 字符），在 Thread ID、Turn ID、Provider、模型、操作、状态、错误类型、错误码与
错误消息中全库匹配后再分页，响应 `total` 为筛选后的匹配总数。
请求、错误、Threads 和 `/threads/:id/turns` 共用精确筛选 `threadId`、`turnId`、`provider`、
`model`、`operation`、`status` 及关键词 `filter`；Provider 筛选为可多选下拉，未选表示全部，点击“查询”后生效。
选项由 `GET /api/v1/providers` 返回指标库全部保留记录中的 Provider 名单，不受当前页或概览前 20 组限制；该接口不接受查询参数。
多选使用重复参数（如 `provider=openai&provider=deepseek`），Provider 之间取并集并去重，其余条件取交集；
分页、汇总、逐层跳转及 JSON 导出保留同一组 Provider。`turnId` 必须有对应 Thread
（每轮接口使用路径中的 Thread）。操作支持 `response|compact`，状态支持
`completed|failed|incomplete|unknown`；未知字段、除 `provider` 外的重复参数或无效值明确返回 400。
会话与轮次排序支持 `time`、`last`、`provider`、`model`、`requests`、`input`、`output`、`compact`；
会话另支持 `thread`、`turns`，轮次另支持 `turn`、`failures`。默认按最近记录倒序，先筛选、汇总和
排序后分页；汇总覆盖全部匹配记录，独立于当前页。错误汇总的分母为相同筛选条件下的全部请求，
错误列表只显示其中未成功的记录。

查询条件保存在页面地址中；Thread → Turn → 请求的跳转保留时间和筛选，重新从第一页查询。
期间统计按请求记录时间的左闭右开区间计算，跨界 Turn 只计入期间请求。Threads 列表和每轮明细
只统计自身，子代理独立列出；详情中的“全部保留历史累计”明确包含子代理，不受期间筛选影响，
对应 `/threads/:id/run`，该累计接口不接受筛选参数。轮数仅表示本机指标库观测到的不同 Turn。
请求页可导出全部匹配结果为 JSON，导出包含所用时间范围、筛选条件与汇总，不限于当前页。
请求明细表不展示 Thread、Turn 列，筛选栏也不提供 Thread ID、Turn ID 输入；从会话或轮次跳转时仍保留
链接中的关联范围，点击“重置”可清除。其他页面的会话与轮次筛选、API 和 JSON 导出的归属字段仍保留。
错误统计同时包含代理观测到的失败模型请求和未发起上游请求的 Turn 级失败（例如 OpenAI 用量上限），
后者显示为无 Token 的 failed 记录；失败记录保存受限长度的错误消息。错误页以发生时间倒序分页
展示每一条失败请求，响应同时保留错误汇总供概览页展示。
全局显示语言支持中文/English 切换（顶部导航右侧，默认中文，选择保存在浏览器
`localStorage` 键 `codex-webui:language`），错误类型等英文原始值会按语言显示；聊天卡片中的
已知 OpenAI 用量上限/额度类错误消息默认以中文展示。
全局深色/浅色主题默认深色，顶部导航右侧按钮切换，选择持久化，刷新后保持。

控制台顶部卡片使用总计、输入、输出三项 Token 口径；总计卡附带请求次数与成功率，输入卡附带
缓存 Token 与命中率。用量趋势图使用输入、缓存、输出三项口径：输入与缓存共用左轴，输出使用右轴独立刻度，
两轴均从零开始；曲线高度不代表跨轴数量相同，悬浮提示保留实际数值。WebUI 中的 Token 与汇总请求数统一使用
`K`、`M`、`B` 英文紧凑单位：Token 的 `K` / `M` 最多保留两位小数、`B` 最多保留三位小数，
汇总请求数最多保留两位小数；明细表请求数仍显示精确整数。
四张卡片下方显示活动热力图和用量趋势图；活动热力图固定展示最近 90 天。控制台默认最近 30 天，顶部时间范围统一切换汇总卡片、趋势图、Provider 和错误汇总。
控制台同时显示本机错误和官方账户额度。官方配额窗口不在 WebUI 展示费用估算；OCG 与 DS
快照超过 15 分钟或尚未采集时，账户卡片会提示刷新。控制台首次打开时自动刷新已配置的 DS 与 OCG
账户；汇总范围旁的刷新按钮同时更新本地指标、固定 90 天热力图和账户快照。WebUI 通过私有 Gateway
IPC 发起账户查询，不读取凭据、不直接调用官方接口，也不定时轮询。查询失败时
保留最后一次有效快照并显示本次错误；OpenCode Go 账户元数据无法读取时只提示该来源异常，不影响
其他 Provider 的有效快照。

API 响应类型由 `scripts/webui-api.ts` 声明，前端从该共享类型导入，不再单独手写镜像。

## 架构

```text
Gateway 指标收集 ──> request-metrics.sqlite3（指标数据库）
                            │ 只读
                            ▼
              scripts/webui-server.mjs（codexc webui 服务）
                ├─ /api/v1/* 指标只读 JSON API（Observability Store 只读模式）
                ├─ /api/v1/management/* 回环限定、令牌按配置启用的结构化配置管理 API
                ├─ /api/v1/traffic* 回环限定的模型转储只读 API
                └─ webui/dist 静态托管
                            ▲
                            │ /api/v1/*（同源，令牌可选）
              webui/（Vite + React 前端）
                ├─ lib/  API 客户端、格式化
                ├─ hooks/ 数据 hook
                ├─ components/ 布局、指标区块与请求明细数据表格
                └─ pages/ 页面组合
```

- 服务端只读查询复用 `codexc metrics` 的同一能力（`metrics-database-access.mjs` /
  `metrics-export-format.mjs`），不维护平行索引；
- API 响应类型单一来源是 `scripts/webui-api.ts`，前端只做转出；
- 前端构建产物随 npm 包发布，`codexc webui` 不依赖源码目录即可托管。

## 边界与安全

- 默认只监听回环地址；绑定非回环地址（`0.0.0.0`）时必须启用访问令牌，否则拒绝启动，
  令牌比较使用常数时间算法，令牌存浏览器 `localStorage`，重新打开浏览器仍可复用；
- 指标数据库以只读模式打开；设置修改只经过 Config 结构化写入口，不直接写数据库；
- 静态资源按白名单扩展名提供，路径限制在 `webui/dist` 内。

边界约束：

- WebUI 不读取、不解析业务会话库；App Server 用户设置通过后端结构化 RPC 适配器访问，不把协议或凭据暴露给前端；
- 转储页只接受真实回环连接，且只按已知标签读取用户数据目录下 `traffic/` 的 JSON Lines，不接受任意
  路径；该页展示的是未脱敏的原始 prompt、代码与工具输出，不要分享截图或展开内容；
- 指标 API 不提供写接口；设置管理仅允许计划内字段，并修改对应结构化入口；敏感 Provider 凭据只写入私有凭据目录；
- 指标 API 只接受 GET，设置管理只接受明确的 JSON POST/PATCH/DELETE；未知 API 与非 `/api/v1` 前缀统一返回 JSON 404；
- 配置的令牌只用于 API 鉴权；服务端不写入日志或响应体，浏览器端访问令牌按前述约定保存在 `localStorage`。

## 前端

前端是独立的 Vite + React 子项目（`webui/`），UI 全部使用 shadcn 组件：

```text
webui/src/
  lib/         API 客户端、共享类型转出与格式化（Token/时间）
  hooks/       资源数据 hook（统一 loading/error/refetch）
  components/  Sidebar 布局、指标区块、共享数据表格组件与转储摘要/明细区块
  pages/       概览、Threads、Thread 详情、请求、错误、转储、设置
```

设置页按 App Server、Provider、Gateway、Workspace 与 WebUI 分区；每个已开放分区在同一位置展示当前值和修改控件，预览与确认写入紧邻对应设置。页面重新获得焦点时会读取当前设置；后台读取保留已有卡片内容，避免刷新时闪烁。App Server 用户默认值、Fast、联网搜索、计划工具、上下文管理、空闲总结、模型压缩、其他偏好和权限已经通过结构化 RPC 接入；Gateway 显示、系统、自动化、Telegram 消息格式、代理、Workspace 权限、WebUI 和本地指标存储设置均复用 Config 管理接口。高风险设置使用服务端一次性确认令牌；渠道授权和服务维护任务仍保留独立任务边界。

Provider 状态卡会在当前主 Provider 为 OpenAI 官方时检查 `CODEX_HOME/auth.json`；未检测到鉴权文件
时按官方未登录处理，不把“OpenAI 官方”作为主 Provider 展示，而是显示“未登录”状态。

请求明细与每轮明细共用共享数据表格组件（TanStack Table v9 组合 shadcn 基础组件），
支持服务端组合筛选、排序与分页，以及列显隐和行选择，表格在视口内内部滚动，输入、输出与
缓存列悬浮显示明细；请求明细的 `User-Agent` 列展示该请求实际发往模型上游的 UA（截断显示，
悬浮查看完整值，Schema v13 起入库，当前 Schema v14 继续保留，早期历史记录显示 `—`）；请求明细的列排序作用于所选时间范围的全部记录，再由服务端偏移
分页，每页条数支持 10–500。Threads 的“期间首次请求”表示匹配条件中首个请求的
开始时间，不等同于 App Server 中 Thread 对象的创建时间；Threads 的“类型”列把已由
Gateway 捕获到 `subAgentActivity` 通知的线程标注为“子代理”，其余显示“主会话”，
子代理标记与请求统计一同持久化在指标库中。

设置页的“官方 TUI 请求身份”分区显示当前生效 UA 与取值来源（显式覆盖或 App Server 生成），
并用最近一条请求记录实际发出的 UA 判断配置是否已生效：两者一致显示“已生效”；在显式覆盖下
不一致时提示“配置已保存，重启后生效”；没有覆盖时不判断是否重启，只显示“与最近一次请求
不一致”。还没有请求样本时不做判断。

部署：仓库根目录 `npm run install:global` 会自动安装 webui 依赖并构建
`webui/dist/`，产物随 npm 包发布，由 `codexc webui` 托管。

开发：仓库根目录 `npm run webui:dev` 一键并行启动 `codexc webui`
（API，默认 `127.0.0.1:8787`）与 Vite dev server（热更新，默认 `5173`）。
开发入口会读取 `[webui]` 配置并让 `/api` 代理跟随实际 API 端口；也可以手动先运行
`codexc webui`，再 `cd webui && npm run dev`（手动启动时代理默认指向 `8787`）。
开发代理会将设置管理请求的 Origin 还原为后端地址，因此预览和低风险修改与生产静态托管使用同一套回环 Origin 约束。
