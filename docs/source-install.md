# Git 源码安装

Linux、macOS 与 Windows 可以把 Codex Connect 官方 `main` 分支作为完整 Git 仓库安装到：

```text
~/.codex-connect/codex-channels
```

配置、数据库、凭据、Socket、日志和输出仍使用 `~/.codex-connect` 下原有目录，不写入 Git
仓库。Windows 使用 PowerShell 7 和当前用户计划任务；在全部 Windows 发布门槛通过前，该入口仍属于
开发验证，不代表项目已经公开支持 Windows。

项目不再发布新的 npm 版本，后续 Gateway 更新通过受管 Git 源码安装完成。历史 npm 包保持原样。

## 安装

先安装 Node.js 22.13 或更高版本、Git 和 npm，然后运行：

```bash
curl -fsSL https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.sh | sh
```

`install.sh` 与 `npm run install:global` 共用沙盒运行依赖检查，无需先初始化渠道：

- macOS 检查系统自带的 `/usr/bin/sandbox-exec`，无需安装 bubblewrap；缺失时明确失败并提示修复系统组件。
- Linux 优先复用系统 `bwrap`；缺失时通过 apt-get（Debian/Ubuntu）或 dnf（Fedora/RHEL）安装 `bubblewrap`。root 直接安装，普通用户使用 `sudo -n`；没有管理员授权、包管理器不支持、安装失败或安装后 PATH 仍不可见时，停止安装并给出手工命令。安装器不更新包索引、不自动提权询问密码。
- 检查 `bwrap --help` 的 `--perms` 能力，与锁定 Codex 的系统 launcher 要求一致。此步骤确认运行依赖，不保证容器、内核、AppArmor 等系统策略允许实际沙盒启动，也不会关闭沙盒或修改这些策略。

锁定 Codex 在 Linux 还支持随 CLI 分发的内置 bubblewrap 回退；本项目源码安装会主动准备系统版本，`codexc doctor` 继续只读报告。Windows 不执行 Linux 依赖安装，也不自动创建沙盒用户或改变 Windows 沙盒配置。

Windows PowerShell 7 使用仓库根目录的安装器：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& .\install.ps1
```

也可以从官方 `main` 分支直接下载并运行安装器：

```powershell
irm https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.ps1 | iex
```

该脚本要求 Git、Node.js 22.13+ 和 npm；Codex CLI 缺失或版本不符时会通过 `npm.cmd`
同步为项目锁定的精确版本，随后重新检查版本与 PATH。它只使用当前用户目录，不要求管理员权限；安装失败会清理临时目录和不完整源码。
默认克隆官方 `main`；本地开发验证可显式传入 `-Repository <本地仓库路径> -Branch <分支>`，该参数不改变
正式安装默认值。安装器会在 Git checkout 时启用长路径支持，以覆盖 Windows 深层源码目录。

安装器先在 `~/.codex-connect` 的私有临时目录完成克隆、依赖安装、Gateway 与 WebUI 构建和版本
校验；`main` 中 `package.json` 的版本必须与本机 Codex CLI 一致。成功后才移动为
`codex-channels`。已有同名目录时不会覆盖。安装前会显示 npm 版本和全局目录，并检测已有的 npm
全局版 `@hegenai/codexc` 及当前 `codexc` 命令来源；源码构建完成后会用当前 `main` 构建结果替换
当前 Node.js 环境中的同名全局包。
Codex CLI 是 Gateway 的必需运行时。安装器找不到 `codex` 时，会通过 npm 安装与 `main` 项目版本
一致的 `@openai/codex`；已有版本不匹配时也同步到锁定版本，可能升级或降级。同步失败或 PATH 仍指向其他版本时停止安装。安装器使用固定版本官方
`codex login status` 检查登录状态；未登录或状态检查错误不阻止源码安装，用户需先运行该命令诊断，
并在未登录时执行 `codex login`。npm 全局 `bin` 不在 PATH 时，自动安装后会明确停止并提示修正。
安装器把构建产物打成临时 npm 包并安装到 `npm prefix --global`，因此不会把源码路径显示为 npm
依赖，也不会写入 `.zshrc`、`.bashrc` 或 `.profile`。安装使用当前 Node.js 环境的全局目录；使用
fnm、nvm 等版本管理器时，切换 Node.js 版本也会切换对应的全局命令。随后执行：

```bash
codexc init
codexc setup
codexc install
```

Windows 若 Git 仍报告 `Filename too long`，先在普通 PowerShell 中启用当前用户的 Git 长路径配置，
再重新运行安装器；这不会修改仓库工作树，也不需要管理员权限：

```powershell
& git.exe config --global core.longpaths true
& .\install.ps1
```

本地开发验证可指定当前仓库和分支（不会把未提交改动上传到远程）：

```powershell
& .\install.ps1 -Repository 'F:\GitHub\codex-channels' -Branch 'main'
```

Git 仓库用于跟踪和构建 `main`，日常命令由构建后的 npm 全局包提供。安装器会给仓库写入仅位于
`.git/config` 的受管标记和本次 npm 全局目录，不修改工作树；全局包另记录精确源码来源，供卸载识别安装归属。

## 更新

日常更新统一使用：

```bash
codexc update
```

更新统一从本机终端执行，不提供后台任务或任务状态查询。三平台使用同一用户目录中的独占锁，阻止并发更新。
`codex.binary = "codex"` 使用 PATH 中的默认命令，缺失或版本不符时可确认同步；显式指定其他名称或路径时由操作者维护，更新会在停服前拒绝无效或版本不符的二进制，不尝试安装另一个全局 CLI 来替代。

### 交互更新受管源码

源码模式要求仓库无本地修改或自定义提交，且 `origin` 保持官方 HTTPS 地址。命令比较官方 `main`
与当前 checkout 的 commit；发现新提交后，在临时克隆中确认当前 HEAD 可快进到新 HEAD、项目版本
与本机 Codex CLI 一致，并完成 `npm ci`、Gateway/WebUI 构建以及候选源码对当前配置和数据库的只读
预检。随后使用实际 CLI 核对候选源码锁定的公开参数合同、本地权限映射和
`CODEX_HOME/config.toml` 根级及所有 Profile 用户设置；未设置 `CODEX_HOME` 时使用
`~/.codex/config.toml`。即使 `main` 没有新提交或使用本地构建包，也执行同一只读检查。
只有这些步骤全部通过，才记录服务状态并按 WebUI、Relay、Gateway、App Server 顺序停止运行中的服务，安装配套 CLI、切换源码并刷新全局命令。成功及失败恢复均只启动原本运行的服务，顺序为 App Server、Gateway、仍启用的 Relay、未在配置中关闭的 WebUI；配置中关闭的 WebUI 与未启用的 Relay 保持停止，手工停止的服务也保持停止。Windows 临时克隆也启用 Git 长路径支持。

更新通过官方版本化配置事务将 Codex 用户层 `features.daemon_auto_start` 设为 `false`，避免原生终端另起官方后台；已为 `false` 时不重复写入，未设置或为 `true` 时关闭。即使源码与 CLI 无需更新且数据库已满足当前结构，也执行该设置。其他用户偏好与 Provider 模型目录不改写，也不处理历史服务和 PATH。写入失败会使更新明确失败；数据库已就绪时仍按原恢复流程恢复项目服务。此操作不停止已有官方 daemon，不改变其自动更新设置；`codexc remote` 继续连接项目管理的实例。

默认模型由 `codexc config` 交互确认后设置，更新不补写或覆盖模型。

新安装完成配置后也可运行 `codexc update` 应用此设置；以输出“已关闭 Codex 原生 daemon 自动启动”为已执行依据。

以全新安装为基准，状态数据库只接受 Schema v6，指标数据库只接受 Schema v31；新库由正常启动创建。
安装预检只读校验当前版本及结构，其他版本明确拒绝。更新不迁移、重置或删除数据库，也不提供数据库回退入口。
App Server 的会话历史不在这些数据库中。

已有受管源码目录且更新器已使用当前扁平命令时，直接使用 `codexc update`，不要重复运行安装器。

从仍使用 `service` 命名空间的旧版本跨越此次命令改版时，不能直接运行旧更新器：它在切换源码后仍会调用已删除的旧命令，导致服务恢复失败。请先按旧版本自身帮助记录并停止运行中的服务，更新所选源码，在该目录执行 `npm run install:global`；安装成功后按原状态依次运行 `codexc start appserver`、`codexc start gateway`、`codexc start relay`、`codexc start webui`，只启动原先运行的目标。程序目录改变时先执行 `codexc install` 重建服务定义。此过程不迁移或删除用户配置、数据库；安装失败时保持服务停止，保留原源码用于排查和重新安装。新版本拒绝旧命令，不提供兼容别名。

若旧更新器已经切换源码后报服务恢复失败，保留其报告的备份目录，按下文切换后失败的恢复步骤完成全局安装，再用上述新命令恢复原先运行的服务。新更新器的停止与恢复操作会在独立进程中加载当时源码目录自己的服务入口和目标映射。

同一版本号下的新提交仍会更新。受管源码没有新提交时，只读校验配置和数据库并按需同步配套 CLI；CLI 无需更新时不停止服务。本地构建包执行相同检查和 CLI 同步，不更新 Gateway 包；安装工作区代码使用 `npm run install:global`。
从开发仓库执行 `npm run install:global` 不会将其登记为受管 `main` 仓库。该入口（包括内部 `--prepared`）在注册 Gateway 全局命令前检测 Codex CLI：默认 `codex` 缺失或版本不符时通过 npm 同步为 `src/codex-protocol/version.json` 锁定的正式版本，并检查安装后的版本和 PATH，无需初始化或渠道配置。显式 `CODEX_BINARY` 无效或版本不符时明确失败，不替换指定二进制。CLI 无法执行、安装失败或安装后仍不可见时也明确失败。安装不自动登录或启动服务。

本地源码安装与 `codexc update` 的 CLI 候选／全局安装显式使用 `--include=optional`，因为官方 npm
入口依赖当前平台的原生可选包。`Missing optional dependency @openai/codex-…` 表示安装不完整，
不等同于可执行 CLI 的版本不符；命令分别报告这两种情况。已损坏的 CLI 不自动覆盖，默认入口提示
用错误中给出的锁定版本执行 `npm install --global --include=optional @openai/codex@<版本>`，
确认 `codex --version` 成功后重试。显式指定的自定义 `CODEX_BINARY` 仍由操作者修复。
如果重装后仍缺包，需要检查 npm 安装日志、平台架构和源配置，不能仅凭 npm 返回成功认定原生包完整。

### 本地工作树安装与部署

升级范围以实际改动为准，不以分支名称或问题发生的平台为准：Provider 认证、私有凭据、配置事务和共享生命周期的修复会影响 Windows、macOS、Linux。升级前核对目标版本的配置合同；涉及固定 Provider 私有凭据时，按[Provider 备份与恢复说明](provider-integration-guide.md)保留主配置、候选备份及对应凭据目录，不要只备份 `config.toml`。Windows 专属原生组件与三平台共享配置变更应分别核对，不能用某一平台的验证结果代替其他平台的部署确认。

在需要安装的源码根目录运行 `npm run install:global`（Windows 可用 `npm.cmd run install:global`）。命令自动准备依赖、构建 Gateway/WebUI，再安装当前工作树的构建包；未提交改动也会进入构建。仅执行 `npm run build` 不会刷新全局命令。

Windows 构建使用现有 PowerShell 7 提前编译原生 Job/目录保护 DLL，并随包安装；日常命令不再重复编译 C#。无需安装额外编译 SDK。运行时校验源码及 DLL 一致性、PowerShell 主次版本和 .NET 主版本；升级 PowerShell 主次版本后需在当前环境重新运行 `npm run install:global`，源码开发运行 `npm run build`。构建产物缺失或不匹配时明确失败，不自动重编译。内部 `--prepared` 只验证已有产物；显式 `--ignore-scripts` 不会生成 DLL，不能据此得到完整 Windows 安装包。

若命令报告“Windows 原生组件无法加载，尚未检查文件 ACL”，请按提示重新构建或安装；这表示组件或宿主环境不匹配，运行 `codexc security repair` 不能修复该构建问题。

已有运行服务时，先从本机终端记录 `codexc status all` 和 `codexc status webui` 的状态，停止运行中的 WebUI，再执行 `codexc stop all`，然后安装。安装成功后按 App Server、Gateway、Relay、WebUI 顺序只启动先前运行的服务；这里使用显式目标，配置中关闭的 WebUI 不会自动恢复，需要时显式运行 `codexc start webui`。安装失败先处理错误，不启动版本未就绪的服务。程序目录、Node.js 路径或服务模板改变时用 `codexc install` 重建并激活服务定义；该命令会启动核心服务。macOS/Linux 的 50 秒停止期限及 Linux 的有序子进程收尾设置属于模板变更，仅更新程序和重启不能将它们写入已有定义。

`npm run install:global` 不拉取 Git，也不自动管理服务；上面的 `codexc install` 是另行执行的服务操作。自行选择分支并更新源码后重复执行程序安装；没有受管仓库时，`codexc update` 只同步配套 CLI 和校验配置、数据库，不更新本地源码或 Gateway 包。

新设备按 `npm run install:global` → `codexc init` → `codexc setup` → `codexc install` 顺序操作；`codexc update` 仍要求完成初始化和有效渠道配置，不承担空配置初始化。
Windows 首次或旧服务定义不完整时，若任务激活或就绪检查失败，会保留本次生成的服务定义并报告原始失败阶段，便于检查状态、日志和重试；不会删除任务引用的定义后再尝试安装不存在的旧服务。已有完整定义的安装继续恢复旧定义；恢复失败时同时保留原始安装错误。
Windows 安装预检会拒绝权限、类型或大小不安全的旧服务定义与启动器；不会将这些文件用作恢复快照。激活时先停止核心服务和 Relay，再按新定义启动，WebUI 的运行状态保留；App Server 定义缺少 Socket 路径时明确要求重新安装。
Codex 0.160.1 要求 Windows Socket 目录仅允许当前用户访问。App Server 启动前会将项目已受信任的目录 ACL 收紧为上游要求的单条可继承权限，其他运行时写入保留该权限；不接管不同所有者或放行含不受信任主体的 Socket 目录。请用普通用户终端安装，不依赖管理员提权绕过检查。
本地构建包的 `codexc update` 会显示检查开始和完成结果；无需更新时明确提示配套 CLI 无需更新、数据库结构有效。

候选源码完成构建和只读预检后，如默认 Codex CLI 缺失或其要求的版本与本机不一致，交互终端会显示当前版本和
目标版本，并询问是否现在全局安装精确的 `@openai/codex` 版本；提示为 `[Y/n]`，直接回车表示确认。
确认后先把目标 CLI 安装到随候选源码一同清理的临时目录，以该二进制完成真实公开合同和用户设置
检查；只有检查通过才停止服务并修改全局 CLI。输入 `N/n`、临时候选安装或合同检查失败，以及需要确认却处于非交互终端时，不停止服务、不切换源码、不修改全局 CLI，并显示处理命令。全局安装失败发生在停机窗口内，恢复前必须重新校验实际 CLI 和当前配置、数据库；无法通过校验时保持停止。
公开参数发生删除、改名或枚举变化时，候选版本必须先完成代码适配并更新合同快照；用户配置包含
目标 CLI 已退役的值时，更新会指出根级或 `profiles.<name>` 精确字段和实际配置路径并要求手动
删除。命令不把 `untrusted` 等值自动改成 `on-request` 或 `never`，避免在升级中改变审批语义。

构建和预检失败不会影响当前仓库和服务。切换后刷新全局命令或恢复服务失败时，新源码会保留，原
仓库保存在错误消息给出的 `codex-channels.pre-update-*` 路径。全局命令安装未完成时保持服务停止；在所选源码目录执行 `npm run install:global` 完成安装、核对版本后，按原状态启动服务。其他失败会在校验通过后尝试恢复，恢复也失败时同时报告更新与服务错误。不自动回退或删除用户数据。

更新会显示当前与远程 `main` 提交、候选源码克隆、构建预检和切换结果。依赖安装与构建成功时只显示
阶段摘要；失败时输出对应工具的完整错误。源码切换后会重新打包并刷新 npm 全局命令。

Relay 仅接受当前 Key 模型授权格式，不提供旧 Relay 配置转换命令。控制 IPC 当前为 v6，更新相关进程后再确认运行状态，不能混用新 CLI 与旧 Relay 的确认结果。授权格式见[用户指南](user-guide.md)。


## 卸载

```bash
codexc uninstall
```

该命令自动识别当前安装，先停止并卸载后台服务，再卸载当前 `@hegenai/codexc` 全局包，无需另行执行 npm 卸载命令。
官方受管源码安装还会核对全局包中记录的源码来源与受管 Git 标记，删除精确匹配的受管仓库，以及其他已记录 prefix 中来源相同的全局包。
存在多个对应全局包时，最后卸载当前运行的包；其他包卸载失败时保留当前命令以便修复后重试。
本地 `npm run install:global` 与 npm Registry 安装只卸载当前全局包，保留本地工作树；旧全局包缺少安装来源记录时，也保留旁边的受管仓库。
直接在受管仓库运行 CLI 时，只有路径和受管标记均匹配才能删除仓库；普通工作树直接执行 CLI、符号链接或身份冲突会被拒绝。
`config.toml`、数据库、凭据、日志、输出、Codex CLI 和 Shell 配置均保留。服务或 npm 卸载失败时保留源码并报告错误，可修复后重新运行命令。
`codexc uninstall --services` 仍可用于仅卸载后台服务并保留程序。
Linux 会先查询服务单元，只停止和禁用实际存在的服务；已确认未安装的单元跳过，服务管理器不可用或真实停用失败时仍中止卸载并保留程序。
