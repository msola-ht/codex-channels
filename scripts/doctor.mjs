import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parse } from "smol-toml";

import { createDoctorReport, createDoctorTextRenderer } from "./doctor-output.mjs";
import {
  executableInvocation,
  resolveExecutable,
  resolveOptionalExecutable,
} from "../runtime/executable.mjs";
import {
  appServerSocketAcceptsWebSocket,
  inspectAppServerSupervisor,
  sameAppServerTopology,
} from "../runtime/app-server-supervisor.mjs";
import { readAppServerUserAgent } from "../runtime/app-server-read.mjs";
import {
  assertAppServerSocketPathSupported,
  resolveAppServerRuntime,
  resolvePrimaryAppServerSocketPath,
} from "../runtime/app-server-runtime.mjs";
import {
  readGatewayConfig,
  validateGatewayConfigStructureDocument,
} from "../runtime/gateway-config.mjs";
import {
  loadOpenAiBaseUrl,
  loadPrimaryModelProvider,
  validateConfiguredModelProviders,
} from "../runtime/model-provider-runtime.mjs";
import {
  resolveProxyEnvironment,
  selectHttpProxyUrl,
} from "../runtime/network-proxy.mjs";
import {
  assertPrivateDirectoryAccessSync,
  assertCodexConfigAccessSync,
  assertPrivateFileAccessSync,
} from "../runtime/private-file.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { serviceDefinitions } from "../runtime/service-targets.mjs";
import {
  protectForCurrentWindowsUserSync,
  unprotectForCurrentWindowsUserSync,
} from "../runtime/windows-dpapi.mjs";
import { packageDir, resolveConfiguredPath, runtimeConfig, userDataDir } from "./runtime-config.mjs";
import { inspectManagedServiceStatusAsync } from "./service-status.mjs";
import { gatewayOwnerIsReady } from "../runtime/gateway-owner.mjs";
import { inspectWorkspaceConfig } from "./workspace-config.mjs";
import { withCliLifecycleCancellation } from "./cli-lifecycle-command.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";
import { ownedProcessInvocation } from "../runtime/owned-process.mjs";
import { supervisedCliInvocation } from "./cli-command-worker.mjs";
import { childProcessIsRunning, registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";

try {
  await withCliLifecycleCancellation("Doctor 诊断", (signal) => withCliProgress("Doctor 诊断", async (progress) => {

const checks = [];
let queryCleanupFailure;
let checkSection = "基础环境";
const jsonOutput = process.argv.length === 3 && process.argv[2] === "--json";
if (!(process.argv.length === 2 || jsonOutput)) {
  throw new Error("用法：codexc doctor [--json]");
}
const textRenderer = jsonOutput ? undefined : createDoctorTextRenderer();
if (textRenderer) writeText("Codex Connect Doctor\n");
const packageMetadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const protocolMetadata = JSON.parse(
  readFileSync(join(packageDir, "src", "codex-protocol", "version.json"), "utf8"),
);
const requiredAppServerVersion = codexPackageVersion(protocolMetadata.codexCli);

record("Codex Connect", true, `${packageMetadata.name}@${packageMetadata.version}`);
record(
  "Node.js",
  versionAtLeast(process.versions.node, "22.23.4"),
  `${process.version}（要求 >=22.23.4）`,
);
if (process.platform === "linux") {
  const bubblewrap = resolveOptionalExecutable("bwrap");
  if (bubblewrap) {
    record("Linux 沙箱", true, `bwrap 可用：${bubblewrap}`);
  } else {
    note(
      "Linux 沙箱",
      "PATH 中未找到 bwrap；Codex 将回退到内置 helper",
      "Debian/Ubuntu：sudo apt install bubblewrap；"
      + "Fedora/RHEL：sudo dnf install bubblewrap；安装后重新运行 codexc doctor",
    );
  }
}

const explicitConfigFile = process.env.CODEX_CONNECT_CONFIG_FILE?.trim();
const runtime = explicitConfigFile
  ? runtimeConfig()
  : { dataDir: userDataDir(), configPath: join(userDataDir(), "config.toml") };
const { configPath, dataDir } = runtime;
let document;
let primaryAppServerReady = false;

setSection("配置文件");
note("配置来源", `${configPath}（工作区路径来自此文件，与程序安装目录分别配置）`);
if (!existsSync(configPath)) {
  record("用户配置", false, `不存在：${configPath}；请先运行 codexc init`);
} else {
  record("用户配置", true, configPath);
  checkCodexHomePrivatePaths();
  if (explicitConfigFile) {
    note("配置目录权限", "显式配置文件保留父目录现有权限");
  } else {
    checkPrivateDirectory("配置目录权限", dataDir);
  }
  checkPrivateFile("配置文件权限", configPath);
  try {
    const candidate = readGatewayConfig(configPath);
    validateGatewayConfigStructureDocument(candidate);
    document = candidate;
    record("配置格式", true, "TOML 语法与 Gateway Schema 有效");
  } catch (error) {
    record("配置格式", false, errorMessage(error));
  }
}

if (document) {
  const telegram = table(document.telegram);
  const feishu = table(document.feishu);
  const weixin = table(document.weixin);
  const codex = table(document.codex);
  const storage = table(document.storage);
  const stateDatabasePath = resolveConfiguredPath(
    stringValue(storage.database_path),
    dataDir,
    join(dataDir, "data", "gateway.sqlite3"),
  );

  setSection("私有存储");
  checkWindowsCredentialBackend();
  checkOptionalPrivateDirectory("状态目录权限", dirname(stateDatabasePath));
  checkOptionalPrivateFile("状态数据库权限", stateDatabasePath);
  checkOptionalPrivateFile(
    "指标数据库权限",
    join(dirname(stateDatabasePath), "request-metrics.sqlite3"),
  );
  checkOptionalPrivateDirectory(
    "凭据目录权限",
    join(dataDir, "credentials"),
  );
  checkOptionalPrivateDirectory(
    "媒体暂存目录权限",
    join(dirname(stateDatabasePath), "uploads"),
  );
  checkOptionalPrivateDirectory(
    "渠道输出目录权限",
    join(dirname(stateDatabasePath), "channel-outbox"),
  );
  const webui = table(document.webui);
  note(
    "配置内访问令牌",
    [
      `WebUI ${stringValue(webui.token) ? "已配置" : "未配置"}`,
      "内容已隐藏并由配置文件私有权限保护",
    ].join("；"),
  );

  setSection("网络与代理");
  checkOpenAiProxy(document);

  setSection("通讯渠道");
  const tokenConfigured = Boolean(stringValue(telegram.bot_token));
  const channelEnabled = tokenConfigured || feishu.enabled === true || weixin.enabled === true;
  record("渠道启用", channelEnabled, channelEnabled
    ? "至少一个通讯渠道已配置启用"
    : "尚未配置通讯渠道，Gateway 暂不能启动；继续检查工作区及其他独立项目",
  channelEnabled ? undefined : "运行 codexc setup 配置 Telegram、飞书或微信，然后重新运行 codexc doctor");
  const allowedUsers = validAllowedUsers(telegram.allowed_user_ids);
  if (tokenConfigured) {
    record("Telegram Token", true, "已配置（内容已隐藏）");
    record(
      "Telegram 用户",
      allowedUsers,
      allowedUsers ? "允许列表有效" : "telegram.allowed_user_ids 未配置或格式无效",
    );
  } else {
    note("Telegram", "未配置");
  }
  if (feishu.enabled === true) {
    const appId = stringValue(feishu.app_id);
    const appSecret = stringValue(feishu.app_secret);
    const allowedOpenIds = validAllowedOpenIds(feishu.allowed_open_ids);
    record(
      "飞书配置",
      allowedOpenIds,
      allowedOpenIds
        ? `已启用，允许 ${feishu.allowed_open_ids.length} 个用户`
        : "feishu.allowed_open_ids 未配置或格式无效",
    );
    try {
      const {
        inspectFeishuApplicationConfiguration,
        validateFeishuApplication,
      } = await import("./feishu-application.mjs");
      await validateFeishuApplication({ appId, appSecret }, { signal: progress.signal });
      record("飞书应用", true, "凭据与 Bot 身份验证通过（敏感内容已隐藏）");
      try {
        const application = await inspectFeishuApplicationConfiguration({
          appId,
          appSecret,
        });
        record(
          "飞书应用权限",
          application.missingTenantScopes.length === 0,
          application.missingTenantScopes.length === 0
            ? "机器人所需的私聊接收、发送、资源与 CardKit 权限已开通"
            : `缺少 ${application.missingTenantScopes.join("、")}`,
          "重新运行 codexc setup，选择扫码授权并在飞书页面选择当前应用，确认全部权限",
        );
        record(
          "飞书消息事件",
          application.messageEventConfigured && !application.hasPendingVersion,
          application.hasPendingVersion
            ? "存在待审核或待发布版本；生效前机器人可能无法接收消息"
            : application.messageEventConfigured
              ? "私聊消息事件已发布"
              : "私聊消息事件未配置或尚未发布",
          "重新运行 codexc setup 完成配置；如飞书要求审核，请由应用管理员批准版本",
        );
      } catch {
        record(
          "飞书权限与事件",
          false,
          "无法读取应用权限或发布状态",
          "重新运行 codexc setup，选择扫码授权并在飞书页面选择当前应用",
        );
      }
    } catch {
      record("飞书应用", false, "凭据、网络或 Bot 身份验证失败");
    }
  } else {
    note("飞书", "未启用");
  }
  if (stringValue(weixin.account_id)) {
    const accountId = stringValue(weixin.account_id);
    const allowedWeixinUsers = validAllowedWeixinUsers(
      weixin.allowed_user_ids,
    );
    record(
      "微信配置",
      allowedWeixinUsers,
      allowedWeixinUsers
        ? `${weixin.enabled === true ? "已启用" : "未启用"}，允许 ${weixin.allowed_user_ids.length} 个用户`
        : "weixin.allowed_user_ids 未配置或格式无效",
    );
    try {
      const {
        createWeixinCredentialStore,
        createWeixinReplyContextPersistence,
        FileWeixinUpdatesCursorStore,
      } = await import(
        "../dist/surfaces/weixin/index.js"
      );
      const store = createWeixinCredentialStore(
        join(dataDir, "credentials", "weixin"),
      );
      const credential = await store.get(accountId);
      record(
        "微信连接",
        Boolean(credential),
        credential
          ? "安全凭据存在且载荷有效（内容已隐藏）"
          : "安全凭据不存在，请重新运行 codexc setup",
      );
      const cursorStore = new FileWeixinUpdatesCursorStore(
        join(dirname(stateDatabasePath), "weixin-updates"),
      );
      try {
        const cursor = await cursorStore.inspect(accountId);
        note(
          "微信消息游标",
          cursor === null
            ? "尚未建立；首次成功轮询前正常"
            : "检查点存在且载荷有效（内容已隐藏）",
        );
      } catch {
        record("微信消息游标", false, "检查点读取、权限或载荷校验失败；未修改文件");
      }
      if (allowedWeixinUsers) {
        const contexts = createWeixinReplyContextPersistence(
          join(dataDir, "credentials", "weixin-reply-context"),
        );
        let available = 0;
        let latestUpdatedAt = 0;
        try {
          for (const actorId of weixin.allowed_user_ids) {
            const context = await contexts.get({
              surface: "weixin",
              accountId,
              conversationId: actorId,
            });
            if (context !== null) {
              available += 1;
              latestUpdatedAt = Math.max(
                latestUpdatedAt,
                context.updatedAt,
              );
            }
          }
          note(
            "微信上线通知",
            [
              `${available}/${weixin.allowed_user_ids.length} 个允许用户具备加密回复上下文`,
              ...(latestUpdatedAt > 0
                ? [`最近授权消息：${new Date(latestUpdatedAt).toISOString()}`]
                : []),
            ].join("；"),
          );
        } catch {
          record("微信上线通知", false, "加密回复上下文读取或校验失败");
        }
      }
    } catch {
      record("微信连接", false, "安全凭据读取或校验失败");
    }
    note(
      "微信运行时",
      weixin.enabled === true
        ? "配置已启用"
        : "配置未启用；将 weixin.enabled 设为 true 后运行 codexc reload",
    );
  } else {
    note("微信", "未配置");
  }

  setSection("扩展能力");
  const scheduledTasks = table(document.scheduled_tasks);
  if (scheduledTasks.enabled === true) {
    const scheduledTaskPath = join(dirname(stateDatabasePath), "scheduled-tasks.sqlite3");
    if (!existsSync(scheduledTaskPath)) {
      note("Gateway 计划任务", "已启用；数据库将在 Gateway 下次启动时创建");
    } else {
      note("Gateway 计划任务", "已启用，私有数据库已存在");
      checkPrivateFile("计划任务数据库权限", scheduledTaskPath);
    }
  } else {
    note("Gateway 计划任务", "已关闭");
  }
  setSection("工作区");
  try {
    const { workspaces, defaultWorkspaceId } = inspectWorkspaceConfig(document);
    const defaultExists = workspaces.some((workspace) => workspace.id === defaultWorkspaceId);
    record("默认工作区引用", defaultExists, defaultExists
      ? defaultWorkspaceId
      : `default_workspace = ${JSON.stringify(defaultWorkspaceId)} 未匹配任何已登记工作区`,
    defaultExists ? undefined : "运行 codexc work 设置默认工作区，然后重新运行 codexc doctor");
    for (const workspace of workspaces) {
      const available = workspace.status === "available";
      const removal = workspace.id === "codex-connect" || resolve(workspace.cwd) === resolve(dataDir, "workspace")
        ? "固定默认工作区不可移除，请恢复目录或修正 cwd。"
        : /^\d+$/.test(workspace.id) || workspaces.some((entry) => entry.id !== workspace.id && entry.name === workspace.id)
          ? "确认不再使用时运行 codexc work，在菜单中选择该工作区并移除注册，不删除磁盘文件。"
          : `确认不再使用时运行 codexc work remove ${workspace.id} 移除注册，不删除磁盘文件。`;
      record(`工作区 ${workspace.name}（${workspace.id}${workspace.id === defaultWorkspaceId ? "，默认" : ""}）`, available,
        available ? workspace.cwd : `${workspace.detail}\n  配置文件：${configPath}\n  配置项：[[workspaces]] 中 id = ${JSON.stringify(workspace.id)} 的 cwd\n  路径：${workspace.cwd}`,
        available ? undefined : "先检查磁盘挂载、路径和权限；项目已搬家时修改 cwd，保留 id 和其他设置。"
          + removal + "修复后运行 codexc doctor。");
    }
    if (!defaultExists || workspaces.some((workspace) => workspace.status !== "available")) {
      note("影响范围", "当前磁盘配置无法用于 Gateway 启动；热加载失败时已运行的 Gateway 会保留原配置，其当前状态需另行确认。Doctor 只读检查，未移除任何注册。");
    }
  } catch (error) {
    record("工作区配置", false, `${errorMessage(error)}；配置文件：${configPath}`,
      "修正工作区配置后运行 codexc doctor；当前磁盘配置无法用于 Gateway 启动，热加载失败时保留原配置。");
  }

  setSection("Codex 与 App Server");
  const codexCommand = stringValue(codex.binary) || "codex";
  let codexBinary;
  try {
    codexBinary = resolveExecutable(codexCommand);
    const invocation = executableInvocation(codexBinary, ["--version"]);
    const versionResult = await runDoctorCommand(invocation, { timeoutMs: 5_000 });
    if (versionResult.error) {
      throw versionResult.error;
    }
    const actualVersion = versionResult.stdout.trim() || versionResult.stderr.trim();
    record(
      "Codex CLI",
      versionResult.status === 0 && actualVersion === protocolMetadata.codexCli,
      `${actualVersion || "无法读取版本"}（要求 ${protocolMetadata.codexCli}）`,
    );
  } catch (error) {
    record("Codex CLI", false, errorMessage(error));
  }

  const clientIdentity = table(codex.client_identity);
  const clientIdentityConfigured = Object.keys(clientIdentity).length > 0;
  note(
    "App Server 客户端身份",
    clientIdentityConfigured
      ? codex.follow_cli_version === true ? "已启用版本跟随" : "已固定"
      : `默认（codex-tui / ${requiredAppServerVersion}）`,
    "未填写身份时使用当前默认版本；已填写的版本仅在 follow_cli_version = true 时跟随升级。启用跟随可运行 codexc config → 身份与时区 → "
      + "一键设为官方 TUI 身份，之后运行 codexc restart all",
  );
  note(
    "模型上游 User-Agent",
    stringValue(codex.upstream_user_agent)
      ? codex.follow_cli_version === true ? "已启用版本跟随" : "已固定"
      : "默认（App Server 生成的官方 TUI UA）",
    "已填写的 UA 默认固定；follow_cli_version = true 时只更新 Codex 版本，保留系统和终端信息。启用跟随可运行 codexc config → 身份与时区 → "
      + "一键设为官方 TUI 身份，之后运行 codexc restart all",
  );

  const updatePlan = readCodexPlanSetting(process.env);
  if (updatePlan.error) {
    record(
      "Codex 计划清单工具",
      false,
      updatePlan.error,
      "修正 ~/.codex/config.toml 后重新运行 codexc doctor",
    );
  } else {
    note(
      "Codex 计划清单工具",
      updatePlan.enabled ? "已开启" : "已关闭（上游默认）",
      "运行 codexc config → Codex 新会话与用户偏好 → 计划清单工具可修改；Gateway 的 display.plan_updates 只控制渠道展示",
    );
  }

  const socketPath = resolvePrimaryAppServerSocketPath(document, dataDir);
  let appServerTopology;
  let managedProviders = [];
  try {
    const descriptor = resolveAppServerRuntime(document, dataDir, process.env);
    for (const customSwitchingProvider of descriptor.customSwitchingProviders) {
      record(
        `${customSwitchingProvider.provider} 模型提供商配置`,
        true,
        `${customSwitchingProvider.provider} 自定义切换模式有效（Codex 官方模型目录）`,
      );
    }
    const configuredProviders = validateConfiguredModelProviders(process.env);
    for (const configuredProvider of configuredProviders) {
      record(
        `${configuredProvider.provider} 模型提供商配置`,
        true,
        `${configuredProvider.provider} ${configuredProvider.mode === "switching" ? "切换" : "固定"}模式有效`,
      );
    }
    managedProviders = descriptor.managedProviders;
    appServerTopology = descriptor.topology;
  } catch (error) {
    record("模型提供商配置", false, errorMessage(error));
  }
  const observedTopology = appServerTopology
    ? await checkAppServerSupervisor(socketPath, appServerTopology)
    : undefined;
  const appServerChecks = [async (recordCheck) => {
    if (
      appServerTopology
      && observedTopology?.releasedProviders.includes(appServerTopology.primaryProvider)
    ) {
      primaryAppServerReady = true;
      recordCheck(
        "Codex App Server",
        true,
        "已因空闲释放停止；下次消息或 TUI 使用时会按需启动（本次未执行 initialize 核验）",
      );
    } else {
      primaryAppServerReady = await checkAppServer("Codex App Server", socketPath, codexBinary ?? codexCommand, recordCheck);
    }
  }, ...managedProviders.map((managedProvider, index) => (recordCheck) =>
    checkOptionalAppServer(
      `${managedProvider.provider} App Server`,
      appServerTopology.socketPaths[index + 1],
      codexBinary ?? codexCommand,
      recordCheck,
      observedTopology ? observedTopology.runningProviders.includes(managedProvider.provider) : undefined,
    ))];
  // Each connection is independent. Preserve configured report order even when
  // an unavailable Provider takes longer than another connection.
  const appServerResults = await mapChecks(appServerChecks, async (check) => {
    const results = [];
    await check((...values) => results.push(values));
    return results;
  });
  for (const results of appServerResults) {
    for (const values of results) record(...values);
  }
}

async function checkOptionalAppServer(label, socketPath, codexBinary, recordCheck, running) {
  const available = running ?? (process.platform === "win32"
    ? await appServerSocketAcceptsWebSocket(socketPath, { ...process.env, CODEX_BINARY: codexBinary })
    : existsSync(socketPath));
  if (!available) {
    recordCheck(label, true, "已配置；首次选择该 Provider 或恢复其会话时按需启动");
    return;
  }
  await checkAppServer(label, socketPath, codexBinary, recordCheck);
}

async function checkAppServerSupervisor(socketPath, expectedTopology) {
  try {
    const actualTopology = await inspectAppServerSupervisor(socketPath);
    const matches = sameAppServerTopology(actualTopology, expectedTopology);
    record(
      "App Server 监管",
      matches,
      matches
        ? "监管身份有效，Provider 拓扑与当前配置一致"
        : "监管身份缺失、无效或 Provider 拓扑与当前配置不一致",
      matches
        ? undefined
        : "运行 codexc restart all；如仍失败，先停止裸 App Server 后重试",
    );
    return matches ? actualTopology : undefined;
  } catch (error) {
    record(
      "App Server 监管",
      false,
      errorMessage(error),
      "运行 codexc restart all；如仍失败，先停止裸 App Server 后重试",
    );
  }
}

async function checkAppServer(label, socketPath, codexBinary, recordCheck) {
  if (process.platform !== "win32" && !existsSync(socketPath)) {
    recordCheck(label, false, `Socket 不存在：${socketPath}`);
    return false;
  }
  try {
    assertAppServerSocketPathSupported(socketPath);
    const appServerUserAgent = await initializeAppServer(socketPath, codexBinary);
    recordCheck(label, true, `initialize 握手通过：${socketPath}`);
    const actualVersion = appServerVersion(appServerUserAgent);
    recordCheck(
      label === "Codex App Server" ? "App Server 版本" : `${label} 版本`,
      actualVersion === requiredAppServerVersion,
      `${actualVersion ?? "无法识别"}（要求 ${requiredAppServerVersion}）`,
    );
    return true;
  } catch (error) {
    recordCheck(label, false, `连接失败：${errorMessage(error)}`);
    return false;
  }
}

setSection("系统服务");
if (process.platform === "darwin") {
  const uid = process.getuid?.();
  const domain = `gui/${uid}`;
  const labels = serviceDefinitions.filter(definition => definition.core).map(definition => definition.launchd);
  const unsupportedLabels = ["com.msola.codex-app-server", "com.msola.codex-gateway"];
  const launchdResults = await mapChecks([...labels, ...unsupportedLabels], (label) =>
    runDoctorCommand({ file: "launchctl", args: ["print", `${domain}/${label}`] }));
  for (const [index, result] of launchdResults.entries()) {
    if (result.error) note("launchd 查询", `${[...labels, ...unsupportedLabels][index]}：${errorMessage(result.error)}`);
  }
  const loaded = labels.filter((_, index) => launchdResults[index].status === 0);
  const loadedUnsupported = unsupportedLabels.filter((_, index) => launchdResults[index + labels.length].status === 0);
  record(
    "launchd 冲突",
    loadedUnsupported.length === 0 && !launchdResults.slice(labels.length).some((result) => result.error),
    launchdResults.slice(labels.length).some((result) => result.error)
      ? "部分 Job 查询失败，无法确认是否存在不支持的 Job"
      : loadedUnsupported.length === 0
      ? "未检测到不支持的 Job"
      : `检测到不支持的 Job：${loadedUnsupported.join(", ")}；请先手动卸载`,
  );
  note(
    "launchd",
    launchdResults.slice(0, labels.length).some((result) => result.error)
      ? `已确认加载 ${loaded.length}/${labels.length}；部分状态无法查询`
      : loaded.length === labels.length
      ? "App Server 与 Gateway 已加载"
      : `已加载 ${loaded.length}/${labels.length}；前台运行模式可忽略`,
  );
} else if (process.platform === "linux") {
  const units = serviceDefinitions.filter(definition => definition.core).map(definition => definition.systemd);
  const uid = process.getuid?.();
  const serviceQueries = units.map((unit) => ({ file: "systemctl", args: ["--user", "is-active", "--quiet", unit] }));
  if (uid !== undefined) serviceQueries.push({ file: "loginctl", args: ["show-user", String(uid), "--property=Linger", "--value"] });
  const serviceResults = await mapChecks(serviceQueries, (invocation) => runDoctorCommand(invocation));
  for (const [index, result] of serviceResults.entries()) {
    if (result.error) note("systemd 查询", `${index < units.length ? units[index] : "linger"}：${errorMessage(result.error)}`);
  }
  const active = units.filter((_, index) => serviceResults[index].status === 0);
  note(
    "systemd",
    serviceResults.slice(0, units.length).some((result) => result.error)
      ? `已确认运行 ${active.length}/${units.length}；部分状态无法查询`
      : active.length === units.length
      ? "App Server 与 Gateway 已运行"
      : `已运行 ${active.length}/${units.length}；可运行 codexc install 安装用户服务`,
  );
  if (uid !== undefined) {
    const linger = serviceResults[units.length];
    note(
      "systemd linger",
      linger.status === 0 && linger.stdout.trim() === "yes"
        ? "已启用，退出登录后服务可继续运行"
        : "未启用或无法确认；重新运行 codexc install，或按安装提示由管理员启用",
    );
  }
} else if (process.platform === "win32") {
  try {
    const status = await inspectManagedServiceStatusAsync({
      environment: { ...process.env, CODEX_CONNECT_HOME: dataDir, CODEX_CONNECT_CONFIG_FILE: configPath },
      platform: "win32", target: "all",
      run: (file, args, options) => runDoctorCommand({ file, args }, { timeoutMs: 25_000, environment: options.env }),
    });
    const gatewayReady = status.services.some(service => service.target === "gateway" && service.running)
      ? await gatewayOwnerIsReady(configPath).catch(() => false) : false;
    note(
      "Windows 计划任务",
      status.healthy && gatewayReady && primaryAppServerReady
        ? "App Server 与 Gateway 已运行"
        : `已运行 ${status.services.filter((service) => service.running).length}/${status.services.length}；可运行 codexc install 安装当前用户计划任务`,
    );
  } catch (error) {
    note("Windows 计划任务", `无法查询：${errorMessage(error)}`);
  }
} else {
  note("系统服务", "当前平台尚未提供系统服务适配");
}

const report = createDoctorReport(checks);
if (jsonOutput) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else writeText(textRenderer.renderSummary(report));
process.exitCode = report.healthy ? 0 : 1;

function setSection(section) {
  checkCancellation();
  checkSection = section;
  progress.message(`正在检查：${section}`);
  if (textRenderer) writeText(textRenderer.renderSection(section));
}

function writeText(text) {
  progress.log(text, { stream: "stdout" });
}

function record(name, passed, detail, remediation) {
  checkCancellation();
  const check = {
    section: checkSection,
    kind: passed ? "success" : "failure",
    name,
    detail,
    remediation,
  };
  checks.push(check);
  if (textRenderer) writeText(textRenderer.renderCheck(check));
}

function note(name, detail, remediation) {
  checkCancellation();
  const check = { section: checkSection, kind: "note", name, detail, remediation };
  checks.push(check);
  if (textRenderer) writeText(textRenderer.renderCheck(check));
}

function checkPrivateDirectory(name, path, remediation) {
  if (process.platform === "win32") {
    try {
      assertPrivateDirectoryAccessSync(path);
      record(name, true, "当前 SID 私有 ACL 有效");
    } catch (error) {
      record(name, false, errorMessage(error), remediation);
    }
    return;
  }
  checkMode(name, path, 0o700);
}

function checkCodexHomePrivatePaths() {
  if (process.platform !== "win32") return;
  const home = codexHomePath(process.env);
  if (!existsSync(home)) {
    note("Codex 私有配置权限", "尚未创建；首次使用 Codex 用户配置时创建");
    return;
  }
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch (error) {
    record("Codex 私有配置权限", false, errorMessage(error), "检查 Codex Home 目录访问权限；security repair 只修复目录内的 TOML 文件");
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".toml")) {
      if (entry.name === "config.toml") {
        try {
          assertCodexConfigAccessSync(join(home, entry.name));
          record("Codex 共享配置完整性", true, "所有者与写入权限有效；保留上游读取权限，不代表机密性校验");
        } catch (error) {
          record("Codex 共享配置完整性", false, errorMessage(error), "检查配置文件及父目录所有者和写入权限");
        }
      } else checkPrivateFile(`Codex 配置权限：${entry.name}`, join(home, entry.name));
    }
  }
}

function checkPrivateFile(name, path) {
  if (process.platform === "win32") {
    try {
      assertPrivateFileAccessSync(path);
      record(name, true, "当前 SID 私有 ACL 有效");
    } catch (error) {
      record(name, false, errorMessage(error));
    }
    return;
  }
  checkMode(name, path, 0o600);
}

function checkOptionalPrivateDirectory(name, path) {
  if (existsSync(path)) checkPrivateDirectory(name, path);
  else note(name, "尚未创建；首次使用对应功能时创建");
}

function checkOptionalPrivateFile(name, path) {
  if (existsSync(path)) checkPrivateFile(name, path);
  else note(name, "尚未创建；首次使用对应功能时创建");
}

function checkWindowsCredentialBackend() {
  if (process.platform !== "win32") return;
  try {
    const sample = Buffer.from("codexc-doctor-dpapi-v1", "utf8");
    const protectedValue = protectForCurrentWindowsUserSync(sample);
    const restored = unprotectForCurrentWindowsUserSync(protectedValue);
    record(
      "Windows 凭据后端",
      restored.equals(sample),
      restored.equals(sample)
        ? "DPAPI CurrentUser 保护与恢复通过；凭据内容未读取"
        : "DPAPI CurrentUser 恢复结果无效",
      "确认 PowerShell 7 可用，并在当前 Windows 用户下重新运行 codexc doctor",
    );
  } catch (error) {
    record(
      "Windows 凭据后端",
      false,
      errorMessage(error),
      "确认 PowerShell 7 可用，并在当前 Windows 用户下重新运行 codexc doctor",
    );
  }
}

function checkMode(name, path, expected) {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()
      || (expected === 0o700 ? !metadata.isDirectory() : !metadata.isFile())
      || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      record(name, false, "路径类型或属主无效：必须是当前用户拥有的非符号链接目录或文件");
      return;
    }
    const actual = metadata.mode & 0o777;
    record(name, actual === expected, `${actual.toString(8).padStart(3, "0")}（要求 ${expected.toString(8)}）`);
  } catch (error) {
    record(name, false, errorMessage(error));
  }
}

function validAllowedUsers(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => Number.isSafeInteger(item) && item > 0);
}

function validAllowedOpenIds(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && /^ou_.+$/u.test(item));
}

function validAllowedWeixinUsers(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) =>
      typeof item === "string"
      && /^[^\s@]{1,1000}@im\.wechat$/u.test(item));
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readCodexPlanSetting(environment) {
  const path = join(codexHomePath(environment), "config.toml");
  if (!existsSync(path)) return { enabled: false };
  try {
    const document = parse(readFileSync(path, "utf8"));
    const tools = table(document.tools);
    const updatePlan = table(tools.update_plan);
    return { enabled: updatePlan.enabled === true };
  } catch {
    return { enabled: false, error: "Codex 用户配置无法解析" };
  }
}

function checkOpenAiProxy() {
  try {
    if (loadPrimaryModelProvider(process.env) !== "openai") {
      note("OpenAI 代理", "当前主提供商不是 OpenAI，跳过检查");
      return;
    }
    const network = readCodexProxySettings(process.env);
    const proxyEnvironment = resolveProxyEnvironment(network, process.env);
    const configuredBaseUrl = loadOpenAiBaseUrl(process.env);
    const targets = configuredBaseUrl
      ? [configuredBaseUrl]
      : ["https://chatgpt.com/backend-api/codex", "https://api.openai.com/v1"];
    const proxy = {
      http: proxyEnvironment.HTTP_PROXY,
      https: proxyEnvironment.HTTPS_PROXY,
      all: proxyEnvironment.ALL_PROXY,
      no: proxyEnvironment.NO_PROXY,
    };
    const proxiedTargets = targets.filter((target) =>
      selectHttpProxyUrl(proxy, target) !== undefined);
    const hasConfiguredProxy = Boolean(
      proxyEnvironment.HTTP_PROXY
      || proxyEnvironment.HTTPS_PROXY
      || proxyEnvironment.ALL_PROXY,
    );
    const remediation = "运行 codexc config 在 Codex .env 中设置 HTTPS_PROXY，然后运行 codexc restart all";
    const windowsDiscoveryNote = process.platform === "win32"
      ? "；Windows 系统代理未自动读取，使用 Codex .env 或标准代理环境变量"
      : "";

    if (proxiedTargets.length === targets.length) {
      note(
        "OpenAI 代理",
        `已检测到代理，官方模型请求将通过代理连接${windowsDiscoveryNote}`,
      );
      return;
    }
    if (hasConfiguredProxy) {
      note(
        "OpenAI 代理",
        proxiedTargets.length === 0
          ? `代理已配置，但 OpenAI 目标被 NO_PROXY 设为直连${windowsDiscoveryNote}`
          : `部分 OpenAI 目标被 NO_PROXY 设为直连${windowsDiscoveryNote}`,
        remediation,
      );
      return;
    }
    note(
      "OpenAI 代理",
      `未检测到代理，官方模型请求将尝试直连；受限网络中可能无法连接${windowsDiscoveryNote}`,
      remediation,
    );
  } catch (error) {
    record(
      "OpenAI 代理",
      false,
      errorMessage(error),
      "修正 Codex .env 或标准代理环境变量中的代理 URL、NO_PROXY 后重新运行 codexc doctor",
    );
  }
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function versionAtLeast(actual, minimum) {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
}

async function initializeAppServer(socketPath, codexBinary) {
  return readAppServerUserAgent({
    socketPath,
    codexBinary,
    clientInfo: {
      name: "codex_app_server_daemon",
      title: "Codex Connect Doctor",
      version: packageMetadata.version,
    },
  });
}

function codexPackageVersion(value) {
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(value);
  if (!match) {
    throw new Error(`无法解析协议基线版本：${value}`);
  }
  return match[1];
}

function appServerVersion(userAgent) {
  return /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|\()/u
    .exec(stringValue(userAgent))?.[1];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function mapChecks(values, inspect) {
  const results = new Array(values.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length) {
      checkCancellation();
      const index = next++;
      results[index] = await inspect(values[index]);
    }
  }));
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

function runDoctorCommand(invocation, { timeoutMs = 3_000, environment = process.env } = {}) {
  checkCancellation();
  return new Promise((resolveResult) => {
    const owned = supervisedCliInvocation(ownedProcessInvocation(invocation, environment));
    const child = spawn(owned.file, owned.args, {
      env: environment,
      windowsVerbatimArguments: owned.windowsVerbatimArguments,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (process.platform !== "win32") registerChildProcessGroup(child);
    const output = { stdout: [], stderr: [] };
    let outputBytes = 0;
    let settled = false;
    let stopping = false;
    const finish = (error, status = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      progress.signal.removeEventListener("abort", abort);
      resolveResult({
        error, status,
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
      });
    };
    const stop = async (error) => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      try {
        if (!childProcessIsRunning(child)) {
          throw new Error("查询主进程已退出，无法确认持有输出管道的后代进程已退出");
        }
        await terminateChildProcess(child, { gracePeriodMs: 100, forcePeriodMs: 1_000 });
        finish(error);
      } catch (cause) {
        queryCleanupFailure = new Error(`诊断查询进程回收失败，退出未确认：pid=${child.pid}`, { cause });
        finish(queryCleanupFailure);
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
        if (childProcessIsRunning(child)) child.unref();
      }
    };
    const abort = () => { void stop(progress.signal.reason); };
    const timer = setTimeout(() => {
      void stop(Object.assign(new Error(`诊断查询超过 ${timeoutMs / 1_000} 秒`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (chunk) => {
        if (stopping) return;
        outputBytes += chunk.length;
        if (outputBytes > 1_024 * 1_024) {
          void stop(Object.assign(new Error("诊断查询输出超过 1 MiB 上限"), { code: "ENOBUFS" }));
        } else output[stream].push(chunk);
      });
    }
    child.once("error", (error) => { if (!stopping) finish(error); });
    child.once("close", (status, signal) => {
      if (!stopping) finish(signal ? new Error(`诊断查询被信号终止：${signal}`) : undefined, status);
    });
    progress.signal.addEventListener("abort", abort, { once: true });
    if (progress.signal.aborted) abort();
  });
}
function checkCancellation() {
  if (queryCleanupFailure) throw queryCleanupFailure;
  progress.signal.throwIfAborted();
}
  }, { output: process.argv.includes("--json") ? null : process.stderr, delayMs: 250, signal, handleSignals: false }));
} catch (error) {
  process.stderr.write(`${errorMessageForExit(error)}\n`);
  process.exitCode = error?.exitCode ?? 1;
}

function errorMessageForExit(error) {
  return error instanceof Error ? error.message : String(error);
}
