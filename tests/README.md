# 测试

`tests/` 保存 Gateway 的单元测试、模块合同、CLI/服务脚本测试和真实 Codex App Server 合同。
测试文件按实现边界命名；跨平台或跨渠道的共同约束使用共享合同，平台差异留在对应适配器测试中。

## 维护原则

- 新行为优先扩展最接近实现边界的现有测试文件，避免为同一公开行为建立重复套件。
- 测试断言面向公开结果、稳定领域类型和明确失败行为，不复制内部实现步骤。
- 已删除配置或命令只在当前严格 Schema、升级清理或失败关闭仍需要保证时保留回归测试。
- 模型名、版本号和历史字段只在目录基线、迁移或协议合同中作为业务事实；普通夹具使用不依赖产品目录的值。
- 协议、Transport 或共享 App Server 行为变化必须包含真实 App Server 合同，不能只依赖 Mock。
- 不在测试索引中逐项复制断言；具体覆盖以测试文件和实现模块 README 为准。

## 覆盖范围

- `codex-protocol`、`codex-client`：固定版本生成类型、初始化、请求与通知分流、超时和断线清理、Thread/Turn/Item/Goal、Queue、Revert、账户与工具能力。
- `application`、`conversation-core`、`session-routing`：命令编排、状态归约、会话发现与接续、绑定独占、订阅取消和重启恢复。
- `approval`、`policy`、`surfaces`：Actor 与 Workspace 授权、审批关联和失效、输出顺序、平台超时隔离、渠道展示与敏感信息清洗。
- `bootstrap`、`config`、`storage`、`observability`、`provider-proxy`：组合根和生命周期、严格 TOML、当前 SQLite Schema、指标采集及 Provider 转发边界。
- `scheduled-tasks`：Schedule 计算、状态机、存储和调度器合同。
- CLI、WebUI、安装、服务和更新脚本：公开命令、管理接口、构建产物、跨平台服务模板与升级失败行为。
- 模块边界测试：一级模块公开入口、允许依赖方向和生成协议类型隔离。

## 常规验证

运行完整测试：

```bash
npm test
```

该命令先构建当前源码到 `dist/`，再运行测试，避免 CLI 和 Doctor 用例读取旧构建产物。

生成包含未执行源码的 V8 Coverage 报告：

```bash
npm run test:coverage
```

HTML 报告写入被 Git 忽略的 `coverage/`。项目记录覆盖情况，但不设置缺乏依据的强制覆盖率阈值。

## 真实 App Server 合同

CI 的隔离合同要求安装项目锁定版本的 Codex CLI，但不需要登录，也不会调用模型：

```bash
TMPDIR=/tmp RUN_CODEX_CONTRACT=1 npm test -- --run \
  tests/real-app-server.test.ts \
  tests/real-app-server-isolated-state.test.ts \
  tests/real-app-server-queue.test.ts \
  tests/real-app-server-supervised-provider.test.ts \
  tests/real-app-server-supervised-thread-state.test.ts \
  tests/real-app-server-supervised-tools.test.ts
```

非 Windows 门禁把临时根固定为 `/tmp`，避免 macOS 默认临时目录使 Unix Socket 路径超过系统限制；
各合同仍使用独立随机子目录。合同覆盖真实握手、跨 Client 状态、Provider 监管、Queue、设置更新、
Goal、Skill、MCP、Plugin、Permission Profile 和工具审批等当前支持矩阵中的能力。跳过或环境拒绝
不计为通过。

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
