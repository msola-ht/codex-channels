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
4. 从目标 CLI 公开帮助刷新本项目实际转发参数的合同快照，重新生成协议并逐文件比较，再校验
   Gateway、协议版本、公开 CLI 合同与本地权限映射一致。
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
- `public-cli-impact.md`：本项目实际转发的公开 CLI 参数、短参数别名、参数形状和枚举值的新增、
  删除与变化；与 App Server 内部协议影响分开报告。
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

正式升级提案使用分阶段验证和报告，不在首个失败处停止。GitHub Release API 的请求或响应正文读取
遇到网络异常时，与 429、5xx 一样最多尝试三次；仍无法解析目标版本时，后续安装和兼容验证跳过，
但工作流仍以 `unresolved-<run id>` 上传解析日志和失败报告，然后标红。自动验证通过表示生成后的项目已经
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
3. 先阅读目标版本官方 Release 的 New Features、Bug Fixes 和 Chores，按 CLI/TUI、App Server
   协议、App Server 内部修复初步筛选与本项目有关的变化；不要从完整源码差异开始漫游分析。
4. 先阅读 `public-cli-impact.md`，确认 Remote 和用户设置实际依赖的参数是否新增、删除、改名或
   改变枚举值；再比较生成的 `ClientRequest`、`ClientNotification`、`ServerNotification` 和
   `ServerRequest`，只核实更新日志涉及的协议变化，以及本项目现有调用路径可能受影响的新增、
   删除和参数变化。
5. 仅对本项目现有路径或准备采用的候选能力，查阅官方 App Server 文档、`rust-v<正式版本>`
   固定版本源码与测试；不能用官方 `main` 猜测锁定版本。
6. 把确认后的官方 Release 变化按本项目分为四类：现有路径必须适配、能给当前 Gateway 带来明确收益、
   暂不采用、纯上游内部变化。每项采用或不采用决定都要写明对应的本地入口、用户价值或拒绝理由；
   并先用一句普通话解释该能力让用户或管理员能做什么，不能只列 RPC、类型名、上游功能清单或
   生成类型数量。
7. 审查 `src/codex-protocol/index.ts` 的受控导出，再沿实际差异检查 `codex-client`、
   `conversation-core`、`approval`、`session-routing` 和其他受影响模块。
8. 先解决类型和现有测试的阻塞点，再验证运行时行为；每解决一层都重新运行最接近的定向测试，
   不能只修复第一个编译错误就宣告完成。
9. 新增的 Notification 可以在明确安全时记录并忽略；新增的 Server Request 必须明确处理或
   安全拒绝，不能悬挂。写请求不能因升级而获得盲目重试或更宽权限。
10. 不为旧 CLI 保留兼容层，不通过扩大模块依赖白名单、审批权限、网络权限或文件权限绕过失败。
11. 更新 `docs/index.md` 的版本、协议数字、固定版本链接、支持矩阵和实现映射；在
   `docs/codex-cli-upgrade-decisions.md` 更新当前取舍与基线影响，不追加重复的逐版本清单；
   本次变更与验证结果记录在升级 PR 和对应发布说明中，并更新所有受影响 README 与测试索引。
12. 增加或调整单元测试；协议、Transport 或共享 App Server 行为变化时补充真实合同测试。
13. 运行本页完整验证，重新审查规则文件、文档索引和最终 Git 差异；未经用户明确要求不提交、
    推送、发布或重建服务。

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
TMPDIR=/tmp RUN_CODEX_CONTRACT=1 npm test -- --run \
  tests/real-app-server.test.ts \
  tests/real-app-server-isolated-state.test.ts \
  tests/real-app-server-queue.test.ts \
  tests/real-app-server-supervised-provider.test.ts \
  tests/real-app-server-supervised-thread-state.test.ts \
  tests/real-app-server-supervised-tools.test.ts
npm run verify:commit
```

非 Windows 升级验证使用短临时根 `/tmp`，避免 macOS 默认临时目录使真实合同的 Unix Socket
超过 `SUN_LEN`；各合同仍创建独立随机子目录。

真实合同测试需要目标版本 Codex CLI，但不调用模型。全部检查通过并经差异审查后，才可以按用户
明确指示提交、推送、重新全局安装并重建服务。

升级 PR 转为 Ready 或合并前，把自动提案的通用描述更新为实际审查结果，至少写明：

- `对本项目的收益`：只写当前 Gateway、Surface 或运维路径实际得到的价值，不照抄上游清单。
- `本次采用`：写明协议和版本基线、本地业务适配、项目入口以及采用理由。
- `本次不采用`：写明未导出、未调用或未加入支持矩阵的上游能力，以及不采用原因；没有项目需求、
  仅生成了类型、属于 TUI/其他宿主或会扩大安全边界，都应明确说明。
- 上述每项能力都先用一句非协议术语解释用途，确保不熟悉上游实现的人也能判断是否需要。
- `风险与验证`：写明安全与兼容风险、本地完整门禁、真实 App Server 合同和 PR CI 结果。
- 同步 [`Codex CLI 升级决策`](codex-cli-upgrade-decisions.md)的当前范围和重新评估条件。
- 合并只更新开发基线，不创建 Tag、GitHub Release 或部署服务。项目不再发布 npm 包。

自动 Draft 会预置上述四个章节和官方 Release 链接，但不会自动替项目做产品判断。PR 保持 Draft
时允许暂留占位文字；转为 Ready 后，`Codex upgrade PR description` 工作流会拒绝缺少章节或仍含
占位内容的描述。项目取舍应以当前支持矩阵、实际入口和验证为证据，不能为了“跟上上游”接入无需求
能力。

## 4. 合并升级基线

升级 PR 通过审查和 CI 后，先同步最新 `main`，解决冲突并重新运行提交门禁。冲突解决提交推送后，
确认 PR 恢复可合并且新一轮 CI 全部通过，再把 Draft 转为 Ready 并使用普通 Merge Commit 合并。
不要通过 Rebase 或强制推送改写已经用于审查的升级历史。

合并升级 PR 只表示 `main` 进入目标 Codex CLI 的开发基线。此时：

- `package.json`、Gateway、生成协议和 CI 已使用目标开发基线；如果尚未决定发布，README 继续
  记录当前源码基线，安装入口始终指向官方 `main`。
- 后续修复和功能修改可以继续基于该版本进行。
- 自动升级提案会把该版本视为已同步，不再重复创建同版本 PR。
- 不创建 `v<版本>` Tag，也不创建 GitHub Release 或部署服务。

合并前确认 PR 当前 merge ref 的 CI 全部通过，合并后同步 `main`。需要继续修改时按普通开发流程提交和验证；在准备正式发布
之前，不要提前创建发布 Tag。

## 5. 正式发布

项目不再发布新的 Gateway npm 包。根目录 `package.json` 设置 `private: true`，仓库不提供
npm 发布工作流、Trusted Publishing 或 npm dist-tag 操作。npm 仍用于依赖安装、本地打包、
全局命令注册和安装官方 Codex CLI；不要因此删除源码安装链路或 tarball 冒烟验证。
已发布的 npm 包、Tag 和历史发行说明保持原样；历史说明中的 npm 发布步骤不再适用于后续版本。

日常交付通过官方 `main` 源码与 `codexc update` 完成，无需为每次合并创建 Tag 或 Release。
只有用户明确要求 GitHub 源码发行时才执行以下步骤：

1. 确认 `main` 与远端同步、工作区干净，待发行提交已通过 PR CI 和完整 `verify:commit`。
2. 校验 `package.json`、锁文件、`src/version.json`、生成协议与 CI 的版本基线一致；保持 README
   的当前源码基线准确。受控的 `-fixN` / `-rc.N` 后缀继续对应同一正式 Codex CLI 基础版本。
3. 运行 `npm run test:package`，验证本地 tarball 安装与干净源码全局安装。不得执行 npm 发布。
4. 审查用户可见改动、风险、验证和安装边界后，在该提交创建新的 `v<版本>` Tag；不得移动旧 Tag。
5. 经授权推送 Tag 并创建对应 GitHub Release。`-rc.N` 标记为 Pre-release，说明中明确该版本是
   源码快照；默认安装器及 `codexc update` 跟随 `main`，不会自动选择此 Tag。不要提供 npm 安装命令。

GitHub Release、全局安装、服务重启和部署都不自动执行。发布不需要修改 npm Registry 上的历史包
或标签，也不得把本地 npm 打包成功表述为 npm 发行完成。

### 带后缀版本的强制收尾

如果明确发行 `-rc.N` 或 `-fixN` 源码快照，核验对应不可变 Tag 和 GitHub Release 后，立即通过独立
PR 把 `package.json`、锁文件、`src/version.json` 和 README 的 `main` 开发基线恢复为无后缀基础版本。
恢复 PR 通过 CI 并合并、确认源码更新器接受 `main` 版本后才算完成；恢复基线不创建新 Tag 或 Release。

旧版源码更新器可能不认识后来新增的后缀，让 `main` 长期停留在后缀版本可能导致旧设备更新失败。
保留已存在的后缀版本解析和历史发行记录，不为停止 npm 发行额外改变协议或版本兼容边界。

## 6. 源码更新与本机验证

受管源码安装用户运行：

```bash
codexc update
codexc doctor
codexc service status
```

`codexc update` 的停止、重建、配套 CLI 同步和重启行为以[源码安装与更新](source-install.md)为准。
安装器不会覆盖已有受管源码目录，已有安装直接使用更新命令。

更新本机环境必须得到明确授权。完成后检查实际源码版本、诊断与所需服务状态；发现缺陷时通过新提交
修复，不移动已经发布的 Tag 或覆盖历史 npm 包。

## 升级失败时

- 脚本在生成前失败：修正它报告的 CLI 版本、工作区或参数问题后重试。
- 脚本在生成后失败：不要再次生成或手工回退；让 Codex 检查当前差异和失败命令。
- 目标版本删除或改变现有协议：直接修改当前实现并升级测试，不增加旧协议兼容层。
- 官方文档与生成类型不同：以目标 CLI 生成类型作为字段事实，以同版本官方源码和测试确认行为。
