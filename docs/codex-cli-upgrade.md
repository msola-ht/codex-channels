# Codex CLI 升级流程

本项目把 Gateway 版本与 Codex CLI App Server 协议版本严格绑定。官方
[App Server Schema 生成说明](https://learn.chatgpt.com/docs/app-server#message-schema)明确指出，
生成结果只对应执行生成命令时的 CLI 版本，因此升级不能只替换 npm 版本号。

当前模块架构已经支持升级：`codex-protocol` 保存版本专属生成类型和受控导出，
`codex-client` 集中处理协议请求与通知，其他业务模块只依赖公开类型。升级通常不需要新增模块或
兼容旧协议；需要做的是重新生成协议，然后由 Codex 逐层审查受影响的公开类型、实现和测试。

## 1. 准备目标 CLI

只采用 [`openai/codex` GitHub Releases](https://github.com/openai/codex/releases) 中非 Draft、
非 Pre-release 的正式发行版。不要采用 `alpha`、`beta`、`rc` 或官方 `main`，也不要同时保留
旧、新协议兼容分支。

确认工作区已经提交且干净，然后运行：

```bash
npm run codex:upgrade -- <正式版本>
```

只检查环境、不修改文件：

```bash
npm run codex:upgrade -- <正式版本> --dry-run
```

脚本会：

1. 拒绝非精确版本、错误 CLI 版本、非仓库根目录和非干净工作区。
2. 调用现有原子协议生成器，替换 `src/codex-protocol/generated/`。
3. 同步 `src/codex-protocol/version.json`、`package.json`、`package-lock.json` 和
   `src/version.json`。
4. 重新生成协议并逐文件比较，再校验 Gateway 与协议版本一致。
5. 列出产生的差异，等待 Codex 审查。

脚本不会安装全局 CLI、自动改业务代码、批量替换文档版本、提交、推送或重建服务。生成失败时
不会执行 Git 回退；这样不会覆盖用户数据，也能保留失败现场供 Codex 诊断。

GitHub Actions 每天自动运行 `Codex upgrade preview`，也支持手动触发。版本留空时读取官方最新
正式 Release；指定版本时会验证对应 `rust-v<版本>` 确实是正式 Release。项目已是该版本时自动
结束，不安装 CLI 或生成 Artifact；发现新版本时生成：

- `base-commit.txt`：生成差异所基于的项目提交。
- `result.txt`：自动生成或验证阶段的 `success` / `failure` 结果。
- `changed-files.txt`：新增、修改、删除和重命名文件清单。
- `diff-stat.txt`：文件与行数统计。
- `upgrade.patch`：供 Codex 在本地读取或应用的完整差异。
- `summary.md`：版本、文件数量和协议目录数量摘要。
- `generation.log`：协议生成过程；生成失败时仍随其他现场上传。

同一摘要会显示在 GitHub Actions Job Summary。该预览不会创建分支、提交、推送或部署。下载
Artifact 后把目录交给 Codex；Codex 先确认本地提交与 `base-commit.txt` 一致，再审查并应用
`upgrade.patch`。如果本地分支已经前进，则重新运行预览或在本地重新生成，不直接强行应用旧 Patch。
协议生成失败时同样会上传报告和日志，随后把工作流标为失败。

## Alpha Canary

`Codex alpha canary` GitHub Actions 每天读取 `openai/codex` 官方 Pre-release，选择最高版本号
且符合 `rust-v<版本>-alpha.<序号>` 的 Alpha。它在临时 Runner 中：

1. 安装对应 npm CLI 并生成该版本专属协议。
2. 运行协议逐文件一致性、TypeScript 与版本检查、全量测试。
3. 使用隔离 `CODEX_HOME` 运行真实 App Server 合同测试，不调用模型。
4. 无论成功或失败，都上传基线、文件清单、Patch、摘要和已有的安装、生成、验证日志。
5. 任一步失败时在 Artifact 上传后把 Canary 标红。

Alpha Canary 只提供正式版本发布前的兼容预警。不得把 Alpha 生成类型、项目版本或针对 Alpha 的
业务适配直接提交到 `main`，也不得更新 `docs/index.md` 的当前稳定版本、固定源码链接或支持矩阵。
需要提前分析时，应由 Codex 在临时分支或 Git worktree 中读取 Artifact；正式 Release 发布后，
仍从正式升级预览重新生成并审查，不能直接复用 Alpha Patch。

## 2. 让 Codex 审查并适配

生成完成后，直接要求：

> 按 `docs/codex-cli-upgrade.md` 审查当前 Codex CLI 升级差异，修复兼容问题并完成验证，不要提交。

Codex 应按以下顺序处理，操作者不需要人工阅读协议文件：

1. 先读取 `AGENTS.md`、`docs/index.md`、本页和相关模块 README。
2. 比较生成的 `ClientRequest`、`ClientNotification`、`ServerNotification` 和
   `ServerRequest`，识别新增、删除及参数变化。
3. 对照目标版本的官方 App Server 文档、固定版本源码与测试；不能用官方 `main` 猜测锁定版本。
4. 审查 `src/codex-protocol/index.ts` 的受控导出，再沿实际差异检查 `codex-client`、
   `conversation-core`、`approval`、`session-routing` 和其他受影响模块。
5. 新增的 Notification 可以在明确安全时记录并忽略；新增的 Server Request 必须明确处理或
   安全拒绝，不能悬挂。写请求不能因升级而获得盲目重试或更宽权限。
6. 更新 `docs/index.md` 的版本、协议数字、固定版本链接、支持矩阵和实现映射，并更新所有受影响
   README 与测试索引。
7. 增加或调整单元测试；协议、Transport 或共享 App Server 行为变化时补充真实合同测试。

若类型生成没有业务差异，Codex 仍需确认版本、文档索引和真实合同，而不是仅凭 TypeScript
编译通过判定升级完成。

## 3. 完成验证

Codex 完成适配后至少运行：

```bash
npm run protocol:check
npm run check
npm run lint
npm run docs:check
npm test
RUN_CODEX_CONTRACT=1 npm test -- --run tests/real-app-server.test.ts
npm run verify:commit
```

真实合同测试需要目标版本 Codex CLI，但不调用模型。全部检查通过并经差异审查后，才可以按用户
明确指示提交、推送、重新全局安装并重建服务。

## 升级失败时

- 脚本在生成前失败：修正它报告的 CLI 版本、工作区或参数问题后重试。
- 脚本在生成后失败：不要再次生成或手工回退；让 Codex 检查当前差异和失败命令。
- 目标版本删除或改变现有协议：直接修改当前实现并升级测试，不增加旧协议兼容层。
- 官方文档与生成类型不同：以目标 CLI 生成类型作为字段事实，以同版本官方源码和测试确认行为。
