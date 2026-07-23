# 测试

本目录包含 Vitest 单元测试、模块边界测试和条件式真实 App Server 集成测试。测试文件按被测模块命名并使用 `.test.ts` 后缀。

## 覆盖范围

- JSON-RPC initialize、消息分流、超时、过载重试和断线清理。
- Thread 新建、列表、恢复、切换、删除、订阅和 Workspace 路由。
- Conversation Core 状态归约、操作过程与敏感文本清洗。
- 审批超时、拒绝、一次性回调和跨客户端解决。
- Telegram 格式、输出队列、生命周期、API 重试及图片输入。
- SQLite 最小绑定恢复、配置、CLI、launchd、systemd、Unix WebSocket 请求头、模块依赖方向和公开入口边界。

常规验证：

```bash
npm test
```

真实 Unix WebSocket/App Server 冒烟测试要求安装受支持的 Codex CLI，但不会调用模型：

```bash
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

新增行为应优先扩展最接近的现有测试文件；协议或 Transport 修改还必须增加真实 App Server 验证，不能只依赖 Mock。
