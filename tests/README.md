# 测试

`tests/` 保存 Gateway 的单元测试、模块合同、CLI/服务脚本测试和真实 Codex App Server 合同。
测试文件按实现边界命名；跨平台或跨渠道的共同约束使用共享合同，平台差异留在对应适配器测试中。

## 维护原则

- 新行为优先扩展最接近实现边界的现有测试文件，避免为同一公开行为建立重复套件。
- 测试断言面向公开结果、稳定领域类型和明确失败行为，不复制内部实现步骤。
- 新增用例须填补具体覆盖缺口；现有测试已证明结果时，不为同义断言另建套件。受本次修改影响的重复覆盖可合并，但不能仅为减少数量删除安全、恢复或失败路径验证。
- 已删除配置或命令只在当前严格 Schema 或失败关闭仍需要保证时保留回归测试。
- 模型名、版本号和历史字段只在目录基线或协议合同中作为业务事实；普通夹具使用不依赖产品目录的值。
- 协议、Transport 或共享 App Server 行为变化必须包含真实 App Server 合同，不能只依赖 Mock。
- 不在测试索引中逐项复制断言；具体覆盖以测试文件和实现模块 README 为准。

CLI 用例按领域直接保存在 `codexc-cli*.test.ts`；`codexc-cli-test-fixture.ts` 只保存共享夹具，各测试文件独立清理临时目录。

## 网络与 Socket 夹具

- Unix Socket 路径须满足所有支持平台中最严格的长度限制，包括随机文件名和嵌套目录。macOS 使用现有的短 `/tmp` 夹具约定，避免系统临时目录过长；目录保持私有并在结束后清理。
- 端口占用夹具必须绑定被测监听器相同的地址族、地址和端口，不能假设通配地址与回环地址在所有平台上都会冲突。
- 不得为使夹具通过而修改生产 Socket 路径、放宽所有权或权限校验。

## 覆盖范围

- `codex-protocol`、`codex-client`：固定版本生成类型、初始化、请求与通知分流、超时和断线清理、Thread/Turn/Item/Goal、Queue、Revert、账户与工具能力。
- `application`、`conversation-core`、`session-routing`：命令编排、状态归约、会话发现与接续、绑定独占、订阅取消和重启恢复。
- `approval`、`policy`、`surfaces`：Actor 与 Workspace 授权、审批关联和失效、输出顺序、平台超时隔离、渠道展示与敏感信息清洗。
- `bootstrap`、`config`、`storage`、`observability`、`provider-proxy`：组合根和生命周期、严格 TOML、当前 SQLite Schema、指标采集及 Provider 转发边界。
- `scheduled-tasks`：Schedule 计算、状态机、存储和调度器合同。
- `persistent-output-faults.test.ts`：持久投递的隔离进程崩溃切点与持续积压资源验证，依赖当前 `dist/`；SIGKILL 切点仅在非 Windows 环境执行。
- `delivery-control.test.ts`、`delivery-queue-reader.test.ts`、`webui-delivery-management.test.ts`、`webui-delivery-page.test.ts`、`webui-delivery-events.test.ts`：投递箱只读分页、在线管理 IPC、在线/离线确认重试和双语队列展示边界。
- `windows-service-control.test.ts`：Windows 服务重启的停止失败隔离与显式停止合同。
- `windows-service-host.test.ts`：Windows 服务子进程启动、控制端点失败与资源回收合同。
- `windows-source-install.test.ts`：在 Windows PowerShell 7 中执行安装器的 Codex 版本同步函数，以隔离命令覆盖缺失、版本差异、安装失败和 PATH 冲突。
- CLI、WebUI、安装、服务和更新脚本：公开命令、管理接口、构建产物、跨平台服务模板与升级失败行为。
- `webui-logs.test.ts`、`webui-logs-page.test.ts`：服务日志参数、鉴权、限量读取、脱敏、平台来源、双语展示和失败边界。
- `webui-component-contracts.test.ts`：公共组件方向、字段错误关联、详情入口焦点目标与 Token 展示边界；SSR 与事件夹具不替代真实浏览器交互验证。
- 模块边界测试：一级模块公开入口、允许依赖方向和生成协议类型隔离。

## 常规验证

开发阶段优先运行与本次行为变化相关的测试，例如：

```bash
npm test -- tests/session-router.test.ts
```

本地提交由 Hook 调用 `npm run verify:commit`，按改动范围选择检查与测试；PR CI 使用
`npm run verify:ci` 执行完整回归。安装冒烟和真实 App Server 合同按相关改动触发，手动 CI 执行完整专项验证。
已有有效结果可以复用，进入审查或交付阶段不要求重新跑一轮。具体范围选择见[验证流程](../.github/workflows/README.md)。

需要完整测试时运行：

```bash
npm test
```

该命令先构建当前源码到 `dist/`，再运行测试，避免 CLI 和 Doctor 用例读取旧构建产物。

生成包含未执行源码的 V8 Coverage 报告：

```bash
npm run test:coverage
```

HTML 报告写入被 Git 忽略的 `coverage/`。项目记录覆盖情况，但不设置缺乏依据的强制覆盖率阈值。

## WebUI 真实浏览器合同

[`browser/webui-contracts.mjs`](browser/webui-contracts.mjs) 启动隔离的回环 Vite 服务，
[`browser/webui-fixture.jsx`](browser/webui-fixture.jsx) 以真实 React StrictMode 挂载生产组件和 Hook。
API 使用受控夹具，浏览器拒绝未声明的网络请求；不会连接当前用户 Gateway、账户或服务。
它补充 SSR/模拟 Hook 无法证明的取消、键盘、焦点与卸载行为，不替代读屏、视觉或性能验收。

浏览器工具不进入项目依赖或常规 `verify:commit`。按需使用已安装的 Playwright，或复用以下临时安装方式：

```bash
npm install --prefix /tmp/codexc-browser-review --no-audit --no-fund playwright@1.63.0
PLAYWRIGHT_BROWSERS_PATH=/tmp/codexc-browser-review/browsers /tmp/codexc-browser-review/node_modules/.bin/playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/tmp/codexc-browser-review/browsers node tests/browser/webui-contracts.mjs /tmp/codexc-browser-review/node_modules/playwright/index.mjs
```

脚本首个参数为 Playwright 模块路径，省略时使用通常的 `import("playwright")`。
依赖只保存在指定临时目录；删除该目录即可移除工具，不需要修改项目包文件。
浏览器没有安装、启动失败或任一合同失败都会返回失败，不计为跳过或通过。
Linux 环境还需 Chromium 运行库及可用字体；精简容器可能只有浏览器文件而缺少这些依赖。
本次使用临时解压库与独立字体配置的执行记录见 [前端关联修复记录](../docs/webui-frontend-review.md#修复后的整合验证)。

## 真实 App Server 合同

CI 的隔离合同要求安装项目锁定版本的 Codex CLI，但不需要登录，也不会调用模型：

```bash
TMPDIR=/tmp RUN_CODEX_CONTRACT=1 npm test -- --run \
  tests/real-app-server.test.ts \
  tests/real-app-server-desktop-bridge.test.ts \
  tests/real-app-server-isolated-state.test.ts \
  tests/real-app-server-queue.test.ts \
  tests/real-app-server-supervised-provider.test.ts \
  tests/real-app-server-supervised-thread-state.test.ts \
  tests/real-app-server-supervised-tools.test.ts \
  tests/real-app-server-responses-provider.test.ts \
  tests/real-app-server-chat-provider.test.ts \
  tests/real-app-server-reset-credits.test.ts
```

非 Windows 门禁把临时根固定为 `/tmp`，避免 macOS 默认临时目录使 Unix Socket 路径超过系统限制；
各合同仍使用独立随机子目录。合同覆盖真实握手、Desktop JSONL stdio 到 Unix WebSocket 的
`initialize` 转换、Desktop 回环桥的双 Client Thread 共享、跨 Client
状态、Provider 监管、Queue、设置更新、Goal、Skill、MCP、Plugin、Permission Profile 和工具审批
等当前支持矩阵中的能力，以及使用隔离模拟账户验证额度查询只读取已有凭证刷新时间且不主动触发 OAuth、重置券读取和幂等消费。
Desktop 桥合同使用普通 App Server Client，不覆盖打包 Desktop 动态创建
的 `CODEX_APP_TOOLS_PIPE_PATH`、代码签名校验或内置 `codex_app` MCP 生命周期；这些能力必须单独
实机验收。跳过或环境拒绝不计为通过。

## 当前用户配置集成冒烟

以下命令验证当前用户配置下的 Unix WebSocket/App Server 链路，同样不会调用模型：

```bash
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

默认流程验证共享 App Server 的跨 Client Thread 发现，以及隔离服务链路中的统计代理、Provider
租约和初始化。若还需验证两个连接依次读取并恢复现有会话，可指定当前 Workspace 内空闲且允许临时
订阅的 Thread：

```bash
CODEX_RESUME_FIXTURE_THREAD_ID=<thread-id> \
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

该模式会接触用户当前 App Server 和指定 Thread；执行前应确认 Thread 空闲，并在结果中单独记录环境问题。

## 持久投递故障与压力验证

`persistent-output-faults.test.ts` 使用临时 Journal、实际 Worker/Coordinator、渠道 Outbox 和
模拟平台，覆盖进程崩溃与持续积压。非 Windows 的 SIGKILL 场景不能作为 Windows 或物理断电证明。
当前运维合同见 [投递箱运维](../docs/delivery.md)，真实平台结论见
[渠道验收矩阵](../docs/channel-acceptance-matrix.md#长正文验收证据)。

```bash
npm test -- tests/persistent-output-faults.test.ts tests/persistent-output.test.ts
```

入口会先构建当前 Worker；夹具不读取真实 Token，不访问真实渠道或停止用户服务。

2026-09-28 已执行的隔离证据如下，历史测量值不是当前机器 SLA，也不代表本次文档整理重跑了测试：

- 飞书链路 8 个切点：提交前、提交后、平台调用前、started 后、模拟平台成功后、首片 confirmed 后、
  确认删除前、确认删除后。恢复后核对原文、检查点、pending/uncertain、同会话屏障和其他会话调度；
  提交前无记录是明确接收缺口，不覆盖 SQLite 事务内部每条指令。
- Telegram 4 个切点：预览 confirmed 后/附件调用前、附件 started 后/平台调用前、模拟平台已收附件/
  confirmed 落盘前、全部 confirmed 后/记录删除前。重启实际 Coordinator 后，首条保持 uncertain、
  同会话后续保持 pending、另一会话继续；没有自动重复附件，显式离线 retry 读回原文与哈希一致。
- 持续积压：Linux / Node 24、4 个账号、8 个停滞平台槽，分批提交 8,192 条各 4 KiB 新会话正文；
  保留 3,852 条、拒绝 4,340 条，后四次采样存量不再增长。逻辑计费 268,222,464 字节、主库
  17.125 MiB；RSS 增量约 28.77 MiB，GC 后主线程堆约 5.16–5.17 MiB，邮箱峰值 34 项/128 KiB。
- 跨层突发：实际 EventBus → SurfaceManager → PersistentSurfaceOutput → Worker/Coordinator →
  飞书 Outbox；挂起 8 个平台槽后同步发布 8,192 条结果，触发过载停止。重开库保留 128 条 pending
  与 8 条 uncertain，未额外启动发送；停止及排空约 56 ms、RSS 增量约 3.86 MiB。

上述是离散采样和模拟平台结果，不证明长期无泄漏、设备耐久、生产网络故障恢复或无限输入零丢失。
授权 owner v2、关闭时派生终态排空及异步计划任务撤权回归分别由
`persistent-output-ownership.test.ts`、`surface-output-chain.test.ts`、
`subagent-completion-tracker.test.ts`、`gateway-startup-cleanup.test.ts` 和
`scheduled-task-executor.test.ts` 维护；当前行为以这些测试及运维文档为准，不沿用修复前的执行阻塞规则。
