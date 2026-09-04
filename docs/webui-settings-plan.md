# WebUI 设置页改造计划

## 目标

在现有指标 WebUI 中增加受控的本机设置页，让用户能够查看 CLI `codexc config`、`codexc setup` 和
`codexc service` 的可视化状态，并逐步开放低风险配置修改。设置页不执行任意 Shell，不解析终端文案，
设置读取和低风险修改复用同一个 WebUI Bearer 令牌，不把凭据写入浏览器。

## 不可回退约束

- WebUI 的指标读取和设置读写始终使用同一个 `webui.token`；不恢复独立管理凭据、管理登录、登出接口、
  管理 Cookie 或第二套浏览器会话。
- 高风险操作继续保留在 CLI。即使未来评估接入 WebUI，也只能在同一 Bearer 鉴权上叠加操作级预览、确认、
  任务和审计，不得重新引入另一套管理认证。

## 现状与事实来源

- `scripts/webui-server.mjs` 提供指标 GET API 与受保护的低风险设置 API；`GET /api/v1/settings` 返回全局显示币种与汇率，
  `GET /api/v1/settings/summary` 返回脱敏配置摘要（保留基础服务状态兼容字段），`GET /api/v1/management/services` 返回四类受管服务状态、版本和最近错误。
- Config/Setup 的结构化管理接口和修订保护已在 `scripts/` 与 `runtime/` 完成，CLI 菜单只是交互适配器。
- 管理接口的 Origin、请求限制、一次性确认、审计和任务安全原语已记录在
  `docs/management-interface-security.md`；WebUI 设置接口直接复用 WebUI Bearer Token，不建立第二套登录。
- 配置事实来源分为 `~/.codex-connect/config.toml`（Gateway、渠道、WebUI、数据中心）和
  `~/.codex/config.toml`（Codex 用户设置、Provider、Profile）；WebUI 不直接读取或改写这些文件。

## 边界

### 首期允许

- 脱敏配置总览：货币、WebUI、Gateway 显示、日志、代理状态、数据中心状态、服务状态。
- 低风险、可逆设置的读取、预览和修改：显示偏好、日志等级、指标保留期、数据中心设备名称及已定义的
  非凭据连接参数。
- 返回结构化修订值、字段错误、变更摘要和明确生效动作（无需重启、reload、重启 Gateway、重启 WebUI
  或重启全部服务）。

### 首期禁止

- OpenAI/第三方登录、扫码 OAuth、Bot Token、API Key、代理值或任何已有 Secret 的读取和写入。
- Provider 新增/删除/切换、OpenCode Go 账户操作、渠道 Setup、数据库 reset/upgrade/normalize、源码更新、
  service stop/install/uninstall 等高风险或长任务。
- 前端执行 CLI、调用任意命令、提交任意 TOML 路径和值，或使用 GET 改变状态。

## 实施阶段

### 阶段一：文档与设置总览页

状态：阶段一、阶段二完成；阶段三只读集成完成，执行型操作仍未开放

- [x] 建立本计划并加入项目文档索引。
- [x] 增加 `/settings` 页面和导航入口（总览只读，低风险修改由阶段二提供）。
- [x] 扩展只读设置 API，返回脱敏配置快照、修订、服务状态和可执行 CLI 提示。
- [x] 明确“已配置/未配置”，不返回 Token、Key、Secret、代理值或配置正文。
- [x] 增加页面 loading/error/空状态，接口失败时不显示伪造默认值并允许重试。
- [x] 增加设置 API 共享类型和路由测试，覆盖旧接口兼容与敏感值不泄露。

### 阶段二：低风险配置管理

- [x] 复用现有 Config 结构化接口，增加明确输入、修订检查和原子写入适配。
- [x] 复用 WebUI Bearer 认证，并接入 Origin、限速、请求上限和审计共享层。
- [x] 写入接口只接受 JSON，拒绝缺失/过期修订，不自动合并并发修改。
- [x] 页面展示预览差异、生效动作和重启提示；写入不自动重启服务。
- [x] 增加冲突、字段错误、未授权、跨源和审计失败关闭测试。

### 阶段三：服务与执行型操作只读集成

- [x] 展示 Gateway、App Server、WebUI、指标中心服务状态、版本和最近错误。
- [x] 对高风险 CLI 提供“复制命令/打开终端”提示，不在 WebUI 直接执行。
- [ ] 若未来开放执行任务，必须先补预览、一次性确认、进度、取消/恢复、任务串行和审计契约。

### 阶段四：Provider/渠道可视化评估

- 状态：阶段四只读概览完成；Provider 和渠道写操作仍未开放。
- [x] 根据管理接口成熟度逐项评估 Provider 和渠道 Setup 是否具备可视化条件。
- [x] 凭据、扫码、OAuth 和服务中断操作维持独立任务边界，未满足安全门槛不得接入页面。

当前批次结果：Provider 只展示主 Provider、Codex 默认模型/思考等级、已配置、可切换和备份 Provider 的安全摘要和共享
第三方子代理状态；渠道只展示 Gateway 已配置与启用状态。Provider URL、Profile、API Key、Token、OAuth、
扫码、账户操作、服务重启和任何配置写入均不进入 WebUI。Provider 读取复用现有 `config/read` 结构化适配器和
`loadModelProviderManagementState`，后端只返回白名单投影；渠道读取复用 Gateway 配置管理的 `channels` 快照。
当前未开放 Provider/渠道运行健康探测、OAuth/扫码流程和配置写入；这些能力需要独立任务、明确审批和审计契约。

## 页面结构

```text
设置
├── App Server 设置（当前状态 + CLI 入口）
├── Provider 状态（只读安全概览）
├── Gateway 设置（当前值 + 修改）
├── WebUI 与数据中心设置（当前值 + 修改）
├── 通讯渠道状态（只读）
├── 服务状态
└── CLI 操作提示
```

每个可编辑区块把当前值和修改入口放在同一位置，只提交对应领域的明确字段，不提供通用键值编辑器。App Server
用户设置、Provider 和账户尚未接入本地 WebUI 时只显示 CLI 入口，不把 Gateway 配置伪装成 App Server 设置。
凭据字段仅显示状态和“使用 CLI 配置”提示，不再额外建立独立的“管理设置”或重复的只读快照区块。

## API 草案

```text
GET  /api/v1/management/settings       读取可编辑设置与 revision（复用 WebUI Bearer 令牌）
POST /api/v1/management/settings/preview 预览低风险设置变更
PATCH /api/v1/management/settings      写入低风险设置（JSON + revision）
GET  /api/v1/management/services       服务状态、版本和最近错误（只读；复用 WebUI Bearer 令牌）
GET  /api/v1/management/providers      Provider 安全概览（只读；复用 WebUI Bearer 令牌）
```

`/api/v1/settings/summary` 和 `/api/v1/management/*` 均使用同一个 WebUI Bearer Token。未配置 WebUI 令牌时，
管理接口失败关闭并返回 `management_requires_webui_token`；页面登录一次后即可读取和修改低风险设置。
已有 `/api/v1/settings` 保持只读兼容，不改变其响应语义。

## 验收标准

- 设置页不读取配置文件、数据库、凭据或 App Server；全部通过后端结构化接口获取。
- API 类型与前端共享，不从中文 CLI 输出推断状态。
- 任意未授权、跨源错误、修订冲突和未知字段均失败关闭。
- 页面明确区分“可在页面修改”和“必须运行 CLI”，不暴露敏感值。
- 低风险写入具备原子性、并发保护、审计和生效提示；服务不会被页面静默重启。
- 每个阶段完成后更新本文件状态，并通过定向测试、构建、Lint、文档检查和提交门禁。

## 回滚

- 阶段一只新增页面和只读路由，删除路由/导航即可回滚，不影响现有指标 API。
- 阶段二每次配置写入沿用现有备份和原子写入机制；冲突或失败不覆盖用户文件。
- 设置管理与指标读取共享 WebUI Token；关闭设置页不影响指标 WebUI 和 Gateway。
