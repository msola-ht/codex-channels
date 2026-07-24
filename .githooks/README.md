# Git Hooks

本目录保存仓库共享的 Git hooks。`npm ci`、`npm install` 或 `npm run hooks:install`
会把本仓库的 `core.hooksPath` 设置为 `.githooks`，不会修改用户的全局 Git 配置。

- `pre-commit`：执行 `npm run verify:commit`；任一类型、Lint、文档索引、测试、Shell、
  打包或差异检查失败都会阻止提交。

需要手动复查时直接运行：

```bash
npm run verify:commit
```

不得用 `git commit --no-verify` 绕过项目检查。若 hook 无法执行，应先修复环境或脚本，
再重新提交。
