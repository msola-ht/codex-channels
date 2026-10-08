# Git Hooks

本目录保存仓库共享的 Git hooks。`npm ci`、`npm install` 或 `npm run hooks:install`
在未禁用生命周期脚本时会把本仓库的 `core.hooksPath` 设置为 `.githooks`，不会修改用户的全局 Git 配置。

- `pre-commit`：先从实际提交索引取得改动范围，再隔离 Git 注入的环境变量，执行
  `npm run verify:commit`。按范围选择必要静态检查与构建；选中的检查失败即阻止提交。
  PR 使用 `npm run verify:ci` 执行完整静态检查与构建。完整类型检查通过后可用
  `--noCheck` 输出 Gateway 产物；日志记录选中范围和检查耗时。

普通提交由 hook 执行一次按范围选择的检查，不在提交前手动重复。修改 CI/门禁、用户明确要求或独立诊断失败时，可手动运行：

```bash
npm run verify:commit
```

不得用 `git commit --no-verify` 绕过项目检查。若 hook 无法执行，应先修复环境或脚本，
再重新提交。
