# Git Hooks

本目录保存仓库共享的 Git hooks。`npm ci`、`npm install` 或 `npm run hooks:install`
在未禁用生命周期脚本时会把本仓库的 `core.hooksPath` 设置为 `.githooks`，不会修改用户的全局 Git 配置。

- `pre-commit`：先从实际提交索引取得改动范围，再隔离 Git 注入的环境变量，执行
  `npm run verify:commit`。按范围选择必要静态检查与依赖图直接相关测试；选中的检查失败即阻止提交。
  源码输入同时映射到 `dist/`，保留直接导入构建产物的测试；没有相关测试时允许跳过。
  动态文件读取、CLI/子进程集成、共享配置及删除的完整影响由 PR CI 回归覆盖，提交时明确报告这个边界。
  安装和真实 App Server 专项留在 CI 按相关范围执行，PR 的完整回归使用 `npm run verify:ci`。
  检查构建产物的用例使用当前构建；完整类型检查通过后可用 `--noCheck` 输出产物。
  干净源码安装保留在显式打包验证、正式发布和升级验证中。日志记录选中范围和检查耗时。

普通提交由 hook 执行一次按范围选择的检查，不在提交前手动重复。修改 CI/门禁、用户明确要求或独立诊断失败时，可手动运行：

```bash
npm run verify:commit
```

不得用 `git commit --no-verify` 绕过项目检查。若 hook 无法执行，应先修复环境或脚本，
再重新提交。
