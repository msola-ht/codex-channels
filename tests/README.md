# 测试

本目录包含 Vitest 单元测试、模块边界测试和条件式真实 App Server 集成测试。测试文件按被测模块命名并使用 `.test.ts` 后缀。

## 覆盖范围

- JSON-RPC initialize、生成类型约束的精确出站消息、初始化断线竞态、消息分流、超时、过载
  重试和断线清理。
- Thread 新建、列表、恢复、切换、删除、订阅、恢复失败绑定保留、关闭/归档/删除通知语义、
  官方响应到稳定路由快照的映射与必需字段失败关闭、活动 Turn 重启恢复和 Workspace 路由。
- 活动 Turn 的即时 steer 与下一 Turn 有界内存队列、顺序启动、Thread 隔离和失败清理；项目输入
  到官方 `UserInput` 的映射，以及 Review、Goal 和控制响应到稳定 Application 结果的映射。
- Conversation Core 状态归约、严格 Turn 完成状态、可重试错误隔离、Thread/全局警告路由、
  操作过程与敏感文本清洗。
- 命令、文件修改、临时权限、用户输入和 MCP 审批的归属信息、一次/会话批准、命令前缀及网络
  规则持久授权、网络专用请求、目标主机一致性、拒绝、无法路由、协议能力约束、一次性回调、
  超时和跨客户端解决。
- 通用 Surface 启停、按账号输出路由与失败隔离；Telegram 格式、通知降噪、长回复折叠与文件回退、
  输出队列、生命周期、API 重试及图片输入。
- Skill 用户与 Workspace 安装过滤、已安装 Plugin 查询及远端市场隔离。
- 官方模型目录到稳定 Application 模型选项的映射、不可见项过滤、必需字段失败关闭，模型、
  思考强度和 Fast 的 Thread 覆盖、Codex 用户级 Fast 默认值持久化、共享客户端完整或残缺设置
  通知、Thread 失效通知及 Gateway/CLI 连接恢复。
- 账户 Token 用量与单桶/多桶额度到稳定 Application 摘要的映射、重置券数量、畸形指标与未知
  枚举失败关闭，以及启动时周限缓存继续使用同一映射结果。
- SQLite 最小绑定恢复、配置热加载与自动重启分类、Setup 类别与通讯渠道菜单、Telegram Setup、
  CLI 项目规则生成/检查、launchd、systemd、Unix WebSocket 请求头、模块依赖方向和公开入口边界。
- TOML、标准环境变量、macOS 系统代理和 Linux GNOME 代理的优先级及服务启动时解析。
- CLI Doctor 的严格 TOML Schema 校验、敏感错误清洗和只读诊断；项目规则限定当前 Workspace、
  拒绝远程覆盖和符号链接路径逃逸；CLI 分级帮助、规范命令名称及 macOS/Linux 服务目标选择；
  一级模块使用完整依赖允许列表并要求跨模块只导入公开入口；Session Routing 不得依赖具体
  Client 或生成协议，Conversation Turn 测试不得伪装成完整 Client。
- 仓库 Git hooks 自动安装与重复执行安全性，以及无本地依赖时的源码安装准备。
- 协议临时生成失败时保留现有类型目录、生成树逐文件比较和安全替换。
- Codex CLI 升级准备脚本的精确版本参数、CLI 输出、干净工作区保护和 Codex 审查交接。
- 官方稳定 Release 校验，以及 CI 升级差异摘要中的文件和协议目录数量。
- 官方 Alpha 过滤与版本排序、GitHub 临时错误有限重试、无差异失败报告，以及临时 Git Index
  对新增文件的完整捕获。
- GitHub Release 响应正文中断后的有限重试，以及目标版本未解析时仍可生成失败报告。
- 升级验证在单项失败后继续执行、保存独立日志和结构化结果，以及 RPC 方法和顶层必填字段差异
  的自动报告。

常规验证：

```bash
npm test
```

生成包含未执行源码的 V8 Coverage 报告：

```bash
npm run test:coverage
```

HTML 报告写入被 Git 忽略的 `coverage/`；当前只记录基线，不设置缺乏依据的强制覆盖率阈值。

CI 中的隔离 App Server 合同测试要求安装受支持的 Codex CLI，但不需要登录，也不会调用模型：

```bash
RUN_CODEX_CONTRACT=1 npm test -- --run tests/real-app-server.test.ts
```

该合同测试使用临时 `CODEX_HOME`，验证一个 Client 写入的 Fast 用户默认值能被另一个 Client
读取，之后新建 Thread 的运行时 `serviceTier` 按 `default → priority → default` 变化，并验证
第二个 Client 修改共享 Thread 的模型、思考强度和 Fast 设置时，订阅方收到完整的
`thread/settings/updated`；第二个 Client 重连后再次修改仍会广播。合同还会启动并立即清理一个
不等待模型结果的 Turn，验证稳定 Turn ID，以及跨 Client 的 Goal 设置、读取和清除映射。

使用当前用户配置的完整 Unix WebSocket/App Server 冒烟测试同样不会调用模型：

```bash
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

默认真实测试会让两个 Client 连接同一个临时 Unix WebSocket App Server，验证一个连接创建的
临时 Thread 会实时广播到另一个连接，并出现在共享的 loaded Thread 列表中；该流程不会启动
模型 Turn。若还要验证两个连接依次读取和恢复同一个已有会话，可显式指定当前 Workspace 中
空闲且允许临时订阅的 fixture Thread：

```bash
CODEX_RESUME_FIXTURE_THREAD_ID=<thread-id> \
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

新增行为应优先扩展最接近的现有测试文件；协议或 Transport 修改还必须增加真实 App Server 验证，不能只依赖 Mock。
