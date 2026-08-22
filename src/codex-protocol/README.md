# Codex Protocol

本目录保存当前支持的 Codex App Server 协议类型和精确 CLI 版本基线。

## 文件与目录

- `index.ts`：只向 `codex-client` 暴露经过审查的最小协议类型集合，包括约束出站消息的
  `ClientRequest`、`ClientNotification`、用户配置编辑值 `JsonValue`，账户用量请求使用的
  `GetAccountTokenUsageParams` 与响应类型，以及原生 Queue、分页历史、Revert 请求/响应和通知类型；
  其他业务模块不得导入。
- `version.json`：记录生成类型对应的 `codex-cli` 版本及实验生成状态。
- `generated/`：由 `codex app-server generate-ts --experimental` 生成的类型，禁止手工修改，
  也不在其内部维护手写索引文档。业务层只允许使用锁定版本官方 Plan 模式所需的
  `collaborationMode/list`、`turn/start.collaborationMode`、Thread Queue、分页历史与 Revert，
  以及受默认关闭配置开关约束的 `plugin/installed` 和 Turn `mention` 调试；其余实验类型不构成支持能力。

升级协议时先阅读 [`docs/codex-cli-upgrade.md`](../../docs/codex-cli-upgrade.md)，在工作区干净且
已安装精确目标 CLI 后执行：

```bash
npm run codex:upgrade -- <目标版本>
```

升级准备脚本调用与 `protocol:generate` 相同的生成器：先生成到同一文件系统的临时目录，只有
CLI 生成和版本读取都成功后才替换当前类型；失败时保留现有生成目录。随后它会以
`protocol:check` 相同的检查重新生成并逐文件比较。脚本只准备版本专属差异，业务适配、文档更新
和完整验证由 Codex 按升级流程审查完成。

Client 新增协议依赖时，应先审查生成差异，再从 `index.ts` 显式导出；不要从任何模块直接导入
`generated/` 内部文件。
