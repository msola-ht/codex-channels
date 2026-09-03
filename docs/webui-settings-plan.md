# WebUI 设置页改造计划

## 目标

在现有只读指标 WebUI 中增加受控的本机设置页，让用户能够查看 CLI `codexc config`、`codexc setup` 和
`codexc service` 的可视化状态，并逐步开放低风险配置修改。设置页不执行任意 Shell，不解析终端文案，
不把只读 WebUI 令牌升级为管理权限，也不把凭据写入浏览器。

## 现状与事实来源

- `scripts/webui-server.mjs` 当前只提供 GET API；`GET /api/v1/settings` 返回全局显示币种与汇率，
  `GET /api/v1/settings/summary` 返回脱敏配置与四类受管服务状态。
- Config/Setup 的结构化管理接口和修订保护已在 `scripts/` 与 `runtime/` 完成，CLI 菜单只是交互适配器。
- 管理接口认证、Origin/CSRF、请求限制、一次性确认、审计和任务安全原语已记录在
  `docs/management-interface-security.md`，接入 HTTP 写路由时必须完整组合，不能复用 WebUI Bearer Token。
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

### 阶段一：文档与只读设置页

状态：阶段一完成，阶段二进行中（管理认证与低风险写入后端已接入，前端编辑界面待完成）

- [x] 建立本计划并加入项目文档索引。
- [x] 增加 `/settings` 页面和导航入口（首期只读）。
- [x] 扩展只读设置 API，返回脱敏配置快照、修订、服务状态和可执行 CLI 提示。
- [x] 明确“已配置/未配置”，不返回 Token、Key、Secret、代理值或配置正文。
- [x] 增加页面 loading/error/空状态，接口失败时不显示伪造默认值并允许重试。
- [x] 增加设置 API 共享类型和路由测试，覆盖旧接口兼容与敏感值不泄露。

### 阶段二：低风险配置管理

- [x] 复用现有 Config 结构化接口，增加明确输入、修订检查和原子写入适配。
- [x] 接入管理认证、短期会话、Origin/CSRF、限速、请求上限和审计共享层。
- [x] 写入接口只接受 JSON，拒绝缺失/过期修订，不自动合并并发修改。
- [ ] 页面展示预览差异、生效动作和重启提示；写入不自动重启服务。
- [ ] 增加冲突、字段错误、未授权、CSRF 和审计失败关闭测试。

### 阶段三：服务与执行型操作只读集成

- [ ] 展示 Gateway、App Server、WebUI、指标中心服务状态、版本和最近错误。
- [ ] 对高风险 CLI 提供“复制命令/打开终端”提示，不在 WebUI 直接执行。
- [ ] 若未来开放执行任务，必须先补预览、一次性确认、进度、取消/恢复、任务串行和审计契约。

### 阶段四：Provider/渠道可视化评估

- [ ] 根据管理接口成熟度逐项评估 Provider 和渠道 Setup 是否具备可视化条件。
- [ ] 凭据、扫码、OAuth 和服务中断操作维持独立任务边界，未满足安全门槛不得接入页面。

## 页面结构

```text
设置
├── 配置总览
├── 显示
├── Gateway
├── WebUI
├── 数据中心
├── 服务状态
└── CLI 操作提示
```

每个区块只提交对应领域的明确字段，不提供通用键值编辑器。凭据字段仅显示状态和“使用 CLI 配置”提示。

## API 草案

```text
POST /api/v1/management/login          使用独立管理凭据建立短期会话
GET  /api/v1/management/settings       读取可编辑设置与 revision（管理会话）
POST /api/v1/management/settings/preview 预览低风险设置变更
PATCH /api/v1/management/settings      写入低风险设置（JSON + revision）
GET  /api/v1/management/services       服务状态（只读）
```

阶段一只实现 WebUI 只读的 `/api/v1/settings/summary`，继续使用已有 WebUI Bearer Token；它不提供配置写入，
也不替代未来必须使用独立管理认证的 `/api/v1/management/*` 路由。已有 `/api/v1/settings` 保持只读兼容，
不改变其响应语义。

## 验收标准

- 设置页不读取配置文件、数据库、凭据或 App Server；全部通过后端结构化接口获取。
- API 类型与前端共享，不从中文 CLI 输出推断状态。
- 任意未授权、Origin/CSRF 错误、修订冲突和未知字段均失败关闭。
- 页面明确区分“可在页面修改”和“必须运行 CLI”，不暴露敏感值。
- 低风险写入具备原子性、并发保护、审计和生效提示；服务不会被页面静默重启。
- 每个阶段完成后更新本文件状态，并通过定向测试、构建、Lint、文档检查和提交门禁。

## 回滚

- 阶段一只新增页面和只读路由，删除路由/导航即可回滚，不影响现有指标 API。
- 阶段二每次配置写入沿用现有备份和原子写入机制；冲突或失败不覆盖用户文件。
- 管理认证与只读 WebUI Token 永远分离；关闭设置页不影响指标 WebUI 和 Gateway。
