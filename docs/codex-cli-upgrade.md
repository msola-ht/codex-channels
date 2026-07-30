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

GitHub Actions `Codex upgrade proposal` 每日检查一次，也可以手动触发。版本留空时读取官方
最新正式 Release；指定版本时会验证对应 `rust-v<版本>` 确实是正式 Release。项目已是该版本时自动
结束，不安装 CLI 或生成 Artifact；发现新版本时生成：

- `base-commit.txt`：生成差异所基于的项目提交。
- `base-version.txt`、`target-version.txt`：稳定基线和本次目标 CLI 版本。
- `result.txt`：自动生成或验证阶段的 `success` / `failure` 结果。
- `results.json`：安装、生成和各验证阶段的机器可读结果。
- `validation-results.json`：独立兼容检查的原始结构化结果。
- `changed-files.txt`：新增、修改、删除和重命名文件清单。
- `diff-stat.txt`：文件与行数统计。
- `upgrade.patch`：供 Codex 在本地读取或应用的完整差异。
- `protocol-impact.md`：相对基线的 RPC 名称、顶层类型字段和生成文件变化。
- `summary.md`：版本、文件数量和协议目录数量摘要。
- `logs/resolve.log`、`logs/install.log`、`logs/generation.log`：官方 Release 解析、目标 CLI
  安装和协议生成过程。
- `logs/*.log`：协议、类型、Lint、测试、真实合同、构建和打包的逐阶段日志。

同一摘要会显示在 GitHub Actions Job Summary。生成与验证 Job 保持只读；全部自动检查成功后，
独立提案 Job 才申请 `contents: write` 和 `pull-requests: write`，把已验证 Patch 应用到自动化
分支并创建 Draft PR。已有同版本开放提案时不重复创建。Draft PR 不自动转为 Ready、合并、发布
或部署，仍需 Codex 完成协议语义、业务实现、稳定文档、CI 锁定版本和测试适配。协议生成或验证
失败时不会创建 PR，但仍上传报告和日志，随后把工作流标为失败。

仓库的 Settings → Actions → General 必须允许 GitHub Actions 创建 Pull Request，同时继续把
默认 `GITHUB_TOKEN` 权限保持为只读；工作流只在提案 Job 中显式提升所需权限。由
`GITHUB_TOKEN` 创建的 PR，其首次 `pull_request` CI 可能显示为等待仓库维护者批准，批准后才会
执行；不使用长期 PAT 绕过该安全闸门。

需要在本地处理失败现场时，下载 Artifact 并交给 Codex。Codex 先确认本地提交与
`base-commit.txt` 一致，再审查并应用 `upgrade.patch`；如果本地分支已经前进，则重新运行提案
或在本地重新生成，不直接强行应用旧 Patch。

## Alpha Canary

`Codex alpha canary` GitHub Actions 每天读取 `openai/codex` 官方 Pre-release，选择最高版本号
且符合 `rust-v<版本>-alpha.<序号>` 的 Alpha。它在临时 Runner 中：

1. 安装对应 npm CLI 并生成该版本专属协议。
2. 独立运行协议一致性、TypeScript 与版本、Lint、全量测试、真实 App Server 合同、构建和
   打包验证；单项失败不阻止后续可独立阶段。
3. 协议预览不修改稳定版文档，因此文档索引阶段明确记录为跳过；正式适配后必须补跑。
4. 自动比较 RPC 方法名称、顶层类型字段和生成文件，并写入协议影响摘要。
5. 无论成功或失败，都上传基线、结构化结果、逐阶段日志、Patch 和摘要。
6. 任一必须阶段失败时在 Artifact 上传后把 Canary 标红。

GitHub Release API 的请求或响应正文读取遇到网络异常时，与 429、5xx 一样最多尝试三次。
三次后仍无法解析目标版本时，后续安装和兼容验证跳过，但工作流仍以
`unresolved-<run id>` 上传解析日志和失败报告，然后标红。

Alpha Canary 只提供正式版本发布前的兼容预警。不得把 Alpha 生成类型、项目版本或针对 Alpha 的
业务适配直接提交到 `main`，也不得更新 `docs/index.md` 的当前稳定版本、固定源码链接或支持矩阵。
需要提前分析时，应由 Codex 在临时分支或 Git worktree 中读取 Artifact；正式 Release 发布后，
仍从正式升级提案重新生成并审查，不能直接复用 Alpha Patch。

正式升级提案使用同一套分阶段验证和报告，不在首个失败处停止。自动验证通过表示生成后的项目已经
通过可自动执行的兼容检查，但不代替 Codex 对官方固定版本源码、行为语义、安全边界和文档更新
的审查。

## 2. 本地让 Codex 审查并适配

正式升级提案发现新版本后，优先在自动创建的 Draft PR 分支继续适配；需要本地重现或提案失败时，
再在干净工作区处理 Artifact 或重新生成。确定性的版本校验、协议生成、差异提取和验证由仓库
脚本负责；协议语义、业务影响、安全边界、源码修改和最终审查由 Codex 负责。不要再编写一个复制
这些脚本的大型“自动修复”程序。

### 直接在当前 Codex 会话中执行

先安装目标正式版本的 Codex CLI，确认工作区干净，然后直接要求：

> 按 `docs/codex-cli-upgrade.md` 审查当前 Codex CLI 升级差异，修复兼容问题并完成验证，不要提交。

如果还没有生成升级工作树，应在请求中给出正式版本：

> 按 `docs/codex-cli-upgrade.md` 将项目适配到 Codex CLI `<正式版本>`，完成协议生成、业务修改、
> 文档更新和验证，不要提交。

Codex 应按以下顺序处理，操作者不需要人工阅读协议文件：

1. 先读取 `AGENTS.md`、`docs/index.md`、本页和相关模块 README。
2. 执行 `git status -sb`，拒绝在不明来源的未提交改动上生成协议；尚未生成时先运行
   `npm run codex:upgrade -- <正式版本> --dry-run`，通过后再运行正式升级命令。
3. 比较生成的 `ClientRequest`、`ClientNotification`、`ServerNotification` 和
   `ServerRequest`，识别新增、删除及参数变化。
4. 对照目标版本的官方 App Server 文档、`rust-v<正式版本>` 固定版本源码与测试；不能采用
   Alpha Patch，也不能用官方 `main` 猜测锁定版本。
5. 审查 `src/codex-protocol/index.ts` 的受控导出，再沿实际差异检查 `codex-client`、
   `conversation-core`、`approval`、`session-routing` 和其他受影响模块。
6. 先解决类型和现有测试的阻塞点，再验证运行时行为；每解决一层都重新运行最接近的定向测试，
   不能只修复第一个编译错误就宣告完成。
7. 新增的 Notification 可以在明确安全时记录并忽略；新增的 Server Request 必须明确处理或
   安全拒绝，不能悬挂。写请求不能因升级而获得盲目重试或更宽权限。
8. 不为旧 CLI 保留兼容层，不通过扩大模块依赖白名单、审批权限、网络权限或文件权限绕过失败。
9. 更新 `docs/index.md` 的版本、协议数字、固定版本链接、支持矩阵和实现映射，并更新所有受影响
   README 与测试索引。
10. 增加或调整单元测试；协议、Transport 或共享 App Server 行为变化时补充真实合同测试。
11. 运行本页完整验证，重新审查规则文件、文档索引和最终 Git 差异；未经用户明确要求不提交、
    推送、发布或重建服务。

若类型生成没有业务差异，Codex 仍需确认版本、文档索引和真实合同，而不是仅凭 TypeScript
编译通过判定升级完成。

### 使用项目技能

后续可以增加项目级 `codex-cli-upgrade-adapter` 技能，把上面的读取顺序、官方资料查询、逐层
修复、验证和停止条件固化下来。技能必须以本页为流程事实来源，并直接复用
`prepare-codex-upgrade.mjs`、`analyze-upgrade-protocol.mjs`、
`run-upgrade-validation.mjs` 和 `write-upgrade-report.mjs`，不得复制一套版本生成或验证逻辑。

技能只负责编排和需要判断的适配工作；精确版本校验、文件生成、报告与测试仍由仓库脚本执行。
技能完成后仍默认停在未提交的本地工作区，等待用户要求审查、提交或推送。

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

升级 PR 转为 Ready 或合并前，把自动提案的通用描述更新为实际审查结果，至少写明：

- 协议和版本基线发生了什么变化。
- 本地业务代码实际适配了什么。
- 生成协议中有哪些新能力仍未导出、调用或加入支持矩阵。
- 本地完整门禁、真实 App Server 合同和 PR CI 的结果。
- 合并只更新开发基线，不创建 Tag、发布 npm 或部署服务。

## 4. 合并升级基线

升级 PR 通过审查和 CI 后，先同步最新 `main`，解决冲突并重新运行提交门禁。冲突解决提交推送后，
确认 PR 恢复可合并且新一轮 CI 全部通过，再把 Draft 转为 Ready 并使用普通 Merge Commit 合并。
不要通过 Rebase 或强制推送改写已经用于审查的升级历史。

合并升级 PR 只表示 `main` 进入目标 Codex CLI 的开发基线。此时：

- `package.json`、Gateway、生成协议、README 和 CI 已使用目标版本。
- 后续修复和功能修改可以继续基于该版本进行。
- 自动升级提案会把该版本视为已同步，不再重复创建同版本 PR。
- 不创建 `v<版本>` Tag，不触发 npm Trusted Publishing，也不创建 GitHub Release 或部署服务。

合并到 `main` 后等待 push CI 全部通过。需要继续修改时按普通开发流程提交和验证；在准备正式发布
之前，不要提前创建发布 Tag。

## 5. 正式发布

只有明确决定对外发布时才执行本节。发布前确认：

1. `main` 已同步远端、工作区干净，目标提交的 GitHub CI 全部通过。
2. `package.json`、`src/version.json`、`src/codex-protocol/version.json`、README 安装命令和
   `ci.yml` 的 Codex CLI 精确版本一致。
3. npm Trusted Publisher 已绑定本仓库的 `publish.yml`。
4. 发布 Tag 与包版本完全一致，并先在本地校验：

```bash
RELEASE_VERSION=0.147.0
npm run release:check -- "v$RELEASE_VERSION"
```

确认无误后，在准备发布的 `main` 提交上创建并推送 Tag：

```bash
git tag -a "v$RELEASE_VERSION" -m "发布 v$RELEASE_VERSION"
git push origin "v$RELEASE_VERSION"
```

`publish.yml` 只监听 `v*` Tag。它会再次校验 Tag 与包版本、运行完整 `verify:commit`，然后通过
npm Trusted Publishing 执行公开发布。普通 push、合并 PR 和手动运行 CI 都不会发布 npm。

等待 `Publish npm package` 工作流成功后再创建对应的 GitHub Release。Release 说明应基于升级
PR 的实际改动、验证结果和发布边界整理，不能继续使用自动提案的通用占位描述。当前工作流不会
自动创建 GitHub Release，也不会自动安装本机包、重启 Gateway 或部署服务。

## 6. 发布后验证与本机升级

先核对 npm 和 GitHub Release，再安装精确版本：

```bash
RELEASE_VERSION=0.147.0
npm view @hegenai/codexc version
npm install -g "@openai/codex@$RELEASE_VERSION"
npm install -g "@hegenai/codexc@$RELEASE_VERSION"
codexc service install
codexc doctor
codexc service status
```

如果需要让 App Server 一并切换到新 CLI，再明确执行：

```bash
codexc service restart all
```

发布完成的判断标准是：npm 返回目标版本、GitHub Release 指向同一 Tag、本机诊断通过且所需服务
状态正常。发布后发现仅文档有误时按普通修复提交处理，不移动已经发布的 Tag；包内容有误时不得
覆盖同一 npm 版本，应先评估并准备新的正式版本。

## 升级失败时

- 脚本在生成前失败：修正它报告的 CLI 版本、工作区或参数问题后重试。
- 脚本在生成后失败：不要再次生成或手工回退；让 Codex 检查当前差异和失败命令。
- 目标版本删除或改变现有协议：直接修改当前实现并升级测试，不增加旧协议兼容层。
- 官方文档与生成类型不同：以目标 CLI 生成类型作为字段事实，以同版本官方源码和测试确认行为。
