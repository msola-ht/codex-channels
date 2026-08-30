# Git Hooks

本目录保存仓库共享的 Git hooks。`npm ci`、`npm install` 或 `npm run hooks:install`
会把本仓库的 `core.hooksPath` 设置为 `.githooks`，不会修改用户的全局 Git 配置。

- `pre-commit`：先清空 git 提交过程注入的临时索引与仓库环境变量，再执行
  `npm run verify:commit`；任一类型、Lint、文档索引、测试、Shell、
  npm tarball 安装或差异检查失败都会阻止提交。完整测试成功生成的 Gateway 构建产物会由随后
  的 tarball 冒烟复用，不重复执行相同构建；干净源码安装只在显式打包验证、正式发布和升级验证
  中执行。输出同时记录每阶段与全部检查耗时，便于定位提交门禁性能回退。

需要手动复查时直接运行：

```bash
npm run verify:commit
```

不得用 `git commit --no-verify` 绕过项目检查。若 hook 无法执行，应先修复环境或脚本，
再重新提交。
