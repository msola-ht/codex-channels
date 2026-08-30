import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import WebSocket from "ws";

import {
  colorizeCliText,
  formatCliStatus,
} from "../runtime/cli-presentation.mjs";
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
import {
  assertAppServerSocketPathSupported,
  resolveAppServerRuntime,
  resolvePrimaryAppServerSocketPath,
} from "../runtime/app-server-runtime.mjs";
import {
  readGatewayConfig,
  validateGatewayConfigDocument,
} from "../runtime/gateway-config.mjs";
import {
  loadConfiguredCustomSwitchingModelProviders,
  loadOpenAiBaseUrl,
  loadPrimaryModelProvider,
  validateConfiguredModelProviders,
} from "../runtime/model-provider-runtime.mjs";
import {
  resolveProxyEnvironment,
  selectHttpProxyUrl,
} from "../runtime/network-proxy.mjs";
import { readApiProviderKey } from "../runtime/api-provider-credential.mjs";
import {
  assertPrivateDirectoryAccessSync,
  assertPrivateFileAccessSync,
} from "../runtime/private-file.mjs";
import { terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { serviceIdentifiers } from "../runtime/service-targets.mjs";
import {
  protectForCurrentWindowsUserSync,
  unprotectForCurrentWindowsUserSync,
} from "../runtime/windows-dpapi.mjs";
import {
  inspectFeishuApplicationConfiguration,
  validateFeishuApplication,
} from "./feishu-application.mjs";
import { packageDir, resolveConfiguredPath, runtimeConfig, userDataDir } from "./runtime-config.mjs";
import { inspectManagedServiceStatus } from "./service-status.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const checks = [];
let checkSection = "基础环境";
const jsonOutput = process.argv.length === 3 && process.argv[2] === "--json";
if (!(process.argv.length === 2 || jsonOutput)) {
  throw new Error("用法：codexc doctor [--json]");
}
const packageMetadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const protocolMetadata = JSON.parse(
  readFileSync(join(packageDir, "src", "codex-protocol", "version.json"), "utf8"),
);
const requiredAppServerVersion = codexPackageVersion(protocolMetadata.codexCli);

record("Codex Connect", true, `${packageMetadata.name}@${packageMetadata.version}`);
record(
  "Node.js",
  versionAtLeast(process.versions.node, "22.13.0"),
  `${process.version}（要求 >=22.13.0）`,
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

setSection("配置文件");
if (!existsSync(configPath)) {
  record("用户配置", false, `不存在：${configPath}；请先运行 codexc init`);
} else {
  record("用户配置", true, configPath);
  if (explicitConfigFile) {
    note("配置目录权限", "显式配置文件保留父目录现有权限");
  } else {
    checkPrivateDirectory("配置目录权限", dataDir);
  }
  checkPrivateFile("配置文件权限", configPath);
  try {
    const candidate = readGatewayConfig(configPath);
    validateGatewayConfigDocument(candidate);
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
  const metricsCenter = table(table(document.metrics).center);
  note(
    "配置内访问令牌",
    [
      `WebUI ${stringValue(webui.token) ? "已配置" : "未配置"}`,
      `指标中心查看令牌 ${stringValue(metricsCenter.token) ? "已配置" : "未配置"}`,
      `设备令牌 ${stringValue(metricsCenter.device_token) ? "已配置" : "未配置"}`,
      "内容已隐藏并由配置文件私有权限保护",
    ].join("；"),
  );

  setSection("网络与代理");
  checkOpenAiProxy(document);

  setSection("通讯渠道");
  const tokenConfigured = Boolean(stringValue(telegram.bot_token));
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
      await validateFeishuApplication({ appId, appSecret });
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
        const cursor = await cursorStore.get(accountId);
        note(
          "微信消息游标",
          cursor === null
            ? "尚未建立；首次成功轮询前正常"
            : "检查点存在且载荷有效（内容已隐藏）",
        );
      } catch {
        record("微信消息游标", false, "检查点读取或校验失败");
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
        : "配置未启用；将 weixin.enabled 设为 true 后运行 codexc service reload",
    );
  } else {
    note("微信", "未配置");
  }

  setSection("扩展能力");
  const apiProviders = Array.isArray(document.api_providers)
    ? document.api_providers.map(table)
    : [];
  for (const provider of apiProviders) {
    try {
      readApiProviderKey(join(dataDir, "credentials"), provider.id);
      record(
        `第三方 API ${typeof provider.name === "string" ? provider.name : provider.id}`,
        true,
        "Responses 配置与私有凭据有效（内容已隐藏）",
      );
    } catch {
      record(
        `第三方 API ${typeof provider.name === "string" ? provider.name : provider.id}`,
        false,
        "私有凭据不存在或权限无效；请重新运行 codexc setup",
      );
    }
  }
  const experimental = table(document.experimental);
  const pluginApiEnabled = experimental.plugin_api === true;
  note(
    "Plugin API",
    pluginApiEnabled
      ? `已启用（开发中；Codex ${requiredAppServerVersion} 暂不保证生产兼容性）`
      : "已关闭",
    pluginApiEnabled
      ? "如需关闭，在 [experimental] 中设置 plugin_api = false 后重启 Gateway"
      : "如需调试，在 [experimental] 中设置 plugin_api = true 后重启 Gateway",
  );
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
  const threadSections = table(document.thread_sections);
  const threadSectionAdministrators = Array.isArray(threadSections.administrators)
    ? threadSections.administrators.filter((value) => typeof value === "string")
    : [];
  note(
    "Thread 分区写权限",
    threadSectionAdministrators.length > 0
      ? `已配置 ${threadSectionAdministrators.length} 个管理员，均属于已启用渠道允许名单`
      : "未配置管理员；仅允许查看和筛选",
    "在 thread_sections.administrators 中使用 <渠道>:<用户 ID> 配置；变更后重启 Gateway",
  );

  setSection("Workspace");
  try {
    const { workspaces, defaultWorkspace } = readWorkspaceConfig(document);
    record("Workspace", true, `${workspaces.length} 个，默认 ${defaultWorkspace.id}`);
  } catch (error) {
    record("Workspace", false, errorMessage(error));
  }

  setSection("Codex 与 App Server");
  const codexCommand = stringValue(codex.binary) || "codex";
  let codexBinary;
  try {
    codexBinary = resolveExecutable(codexCommand);
    const invocation = executableInvocation(codexBinary, ["--version"]);
    const versionResult = spawnSync(invocation.file, invocation.args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
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

  const socketPath = resolvePrimaryAppServerSocketPath(document, dataDir);
  let appServerTopology;
  let managedProviders = [];
  try {
    const customSwitchingProviders = loadConfiguredCustomSwitchingModelProviders(process.env);
    for (const customSwitchingProvider of customSwitchingProviders) {
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
    const descriptor = resolveAppServerRuntime(document, dataDir, process.env);
    managedProviders = descriptor.managedProviders;
    appServerTopology = descriptor.topology;
  } catch (error) {
    record("模型提供商配置", false, errorMessage(error));
  }
  if (appServerTopology) {
    await checkAppServerSupervisor(socketPath, appServerTopology);
  }
  await checkAppServer("Codex App Server", socketPath, codexBinary ?? codexCommand);
  for (let index = 0; index < managedProviders.length; index += 1) {
    const managedProvider = managedProviders[index];
    await checkOptionalAppServer(
      `${managedProvider.provider} App Server`,
      appServerTopology.socketPaths[index + 1],
      codexBinary ?? codexCommand,
    );
  }
}

async function checkOptionalAppServer(label, socketPath, codexBinary) {
  const available = process.platform === "win32"
    ? await appServerSocketAcceptsWebSocket(socketPath)
    : existsSync(socketPath);
  if (!available) {
    record(label, true, "已配置；首次选择该 Provider 或恢复其会话时按需启动");
    return;
  }
  await checkAppServer(label, socketPath, codexBinary);
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
        : "运行 codexc service restart all；如仍失败，先停止裸 App Server 后重试",
    );
  } catch (error) {
    record(
      "App Server 监管",
      false,
      errorMessage(error),
      "运行 codexc service restart all；如仍失败，先停止裸 App Server 后重试",
    );
  }
}

async function checkAppServer(label, socketPath, codexBinary) {
  if (process.platform !== "win32" && !existsSync(socketPath)) {
    record(label, false, `Socket 不存在：${socketPath}`);
    return;
  }
  try {
    assertAppServerSocketPathSupported(socketPath);
    const appServerUserAgent = await initializeAppServer(socketPath, codexBinary);
    record(label, true, `initialize 握手通过：${socketPath}`);
    const actualVersion = appServerVersion(appServerUserAgent);
    record(
      label === "Codex App Server" ? "App Server 版本" : `${label} 版本`,
      actualVersion === requiredAppServerVersion,
      `${actualVersion ?? "无法识别"}（要求 ${requiredAppServerVersion}）`,
    );
  } catch (error) {
    record(label, false, `连接失败：${errorMessage(error)}`);
  }
}

setSection("系统服务");
if (process.platform === "darwin") {
  const uid = process.getuid?.();
  const domain = `gui/${uid}`;
  const labels = serviceIdentifiers("launchd");
  const unsupportedLabels = ["com.msola.codex-app-server", "com.msola.codex-gateway"];
  const loaded = labels.filter((label) =>
    spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0,
  );
  const loadedUnsupported = unsupportedLabels.filter((label) =>
    spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0,
  );
  record(
    "launchd 冲突",
    loadedUnsupported.length === 0,
    loadedUnsupported.length === 0
      ? "未检测到不支持的 Job"
      : `检测到不支持的 Job：${loadedUnsupported.join(", ")}；请先手动卸载`,
  );
  note(
    "launchd",
    loaded.length === labels.length
      ? "App Server 与 Gateway 已加载"
      : `已加载 ${loaded.length}/${labels.length}；前台运行模式可忽略`,
  );
} else if (process.platform === "linux") {
  const units = serviceIdentifiers("systemd");
  const active = units.filter((unit) =>
    spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore", timeout: 3_000 }).status === 0,
  );
  note(
    "systemd",
    active.length === units.length
      ? "App Server 与 Gateway 已运行"
      : `已运行 ${active.length}/${units.length}；可运行 codexc service install 安装用户服务`,
  );
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const linger = spawnSync("loginctl", ["show-user", String(uid), "--property=Linger", "--value"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    note(
      "systemd linger",
      linger.status === 0 && linger.stdout.trim() === "yes"
        ? "已启用，退出登录后服务可继续运行"
        : "未启用或无法确认；重新运行 codexc service install，或按安装提示由管理员启用",
    );
  }
} else if (process.platform === "win32") {
  try {
    const status = inspectManagedServiceStatus({
      environment: {
        ...process.env,
        CODEX_CONNECT_HOME: dataDir,
        CODEX_CONNECT_CONFIG_FILE: configPath,
      },
      platform: "win32",
      target: "all",
    });
    note(
      "Windows 计划任务",
      status.healthy
        ? "App Server 与 Gateway 已运行"
        : `已运行 ${status.services.filter((service) => service.running).length}/${status.services.length}；可运行 codexc service install 安装当前用户计划任务`,
    );
  } catch (error) {
    note("Windows 计划任务", `无法查询：${errorMessage(error)}`);
  }
} else {
  note("系统服务", "当前平台尚未提供系统服务适配");
}

const failures = checks.filter((check) => check.kind === "failure").length;
const successes = checks.filter((check) => check.kind === "success").length;
const notes = checks.filter((check) => check.kind === "note").length;
if (jsonOutput) {
  process.stdout.write(`${JSON.stringify({
    healthy: failures === 0,
    counts: {
      success: successes,
      failure: failures,
      note: notes,
    },
    checks: checks.map((check) => ({
      section: check.section,
      kind: check.kind,
      name: check.name,
      detail: check.detail,
      remediation: check.remediation ?? null,
    })),
  }, null, 2)}\n`);
} else {
  const visibleChecks = checks.filter((check) => check.kind !== "success");
  console.log("Codex Connect Doctor");
  let renderedSection;
  for (const check of visibleChecks) {
    if (check.section !== renderedSection) {
      renderedSection = check.section;
      console.log(`\n=== ${renderedSection} ===`);
    }
    console.log(formatCliStatus(check.kind, check.name, check.detail));
    if (check.remediation) {
      console.log(formatCliStatus("remediation", check.name, check.remediation));
    }
  }
  const summary = failures === 0
    ? `诊断通过：${successes} 项通过，${notes} 项提示。`
    : `诊断发现 ${failures} 项问题：${successes} 项通过，${notes} 项提示。`;
  console.log(`\n${colorizeCliText(failures === 0 ? "success" : "failure", summary)}`);
}
process.exitCode = failures === 0 ? 0 : 1;

function setSection(section) {
  checkSection = section;
}

function record(name, passed, detail, remediation) {
  checks.push({
    section: checkSection,
    kind: passed ? "success" : "failure",
    name,
    detail,
    remediation,
  });
}

function note(name, detail, remediation) {
  checks.push({ section: checkSection, kind: "note", name, detail, remediation });
}

function checkPrivateDirectory(name, path) {
  if (process.platform === "win32") {
    try {
      assertPrivateDirectoryAccessSync(path);
      record(name, true, "当前 SID 私有 ACL 有效");
    } catch (error) {
      record(name, false, errorMessage(error));
    }
    return;
  }
  checkMode(name, path, 0o700);
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
    const actual = statSync(path).mode & 0o777;
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

function checkOpenAiProxy(document) {
  try {
    if (loadPrimaryModelProvider(process.env) !== "openai") {
      note("OpenAI 代理", "当前主提供商不是 OpenAI，跳过检查");
      return;
    }
    const network = table(document.network);
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
    const remediation = "在 config.toml 的 [network] 中设置 https_proxy，"
      + "或为服务设置 HTTPS_PROXY；然后运行 codexc service restart all";
    const windowsDiscoveryNote = process.platform === "win32"
      ? "；Windows 系统代理未自动读取，仅使用 TOML 或标准代理环境变量"
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
      "修正 config.toml 的 [network] 代理 URL 或 NO_PROXY 后重新运行 codexc doctor",
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

async function initializeUnixWebSocket(socketPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      handshakeTimeout: 2_000,
      createConnection: () => createConnection(socketPath),
    });
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("initialize 握手超时")), 3_000);
    timeout.unref();
    const finish = (error, response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(response);
      }
    };
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "codex_connect",
              title: "Codex Connect Doctor",
              version: packageMetadata.version,
            },
            capabilities: {
              experimentalApi: false,
              requestAttestation: false,
              optOutNotificationMethods: null,
            },
          },
        }),
        (error) => error && finish(error),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (message.id !== 1) {
        return;
      }
      if (message.error) {
        finish(new Error(`initialize 被拒绝：${message.error.message || "未知错误"}`));
        return;
      }
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
        (error) => finish(
          error,
          typeof message.result?.userAgent === "string"
            ? message.result.userAgent
            : undefined,
        ),
      );
    });
    socket.once("error", finish);
    socket.once("close", () => finish(new Error("WebSocket 在握手完成前关闭")));
  });
}

async function initializeAppServer(socketPath, codexBinary) {
  if (process.platform !== "win32") {
    return initializeUnixWebSocket(socketPath);
  }
  const { createAppServerTransport } = await import(
    "../dist/codex-client/index.js"
  );
  const transport = createAppServerTransport(
    { kind: "local-app-server", socketPath },
    {
      codexBinary,
      connectTimeoutMs: 3_000,
      createCodexProcessInvocation: (args) => executableInvocation(codexBinary, args),
      terminateCodexProcess: terminateChildProcess,
    },
  );
  await transport.connect();
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const timeout = setTimeout(
        () => finish(new Error("initialize 握手超时")),
        3_000,
      );
      timeout.unref();
      const removeMessage = transport.onMessage((raw) => {
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (message.id !== 1) return;
        if (message.error) {
          finish(new Error(`initialize 被拒绝：${message.error.message || "未知错误"}`));
          return;
        }
        void transport.send(
          JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
        ).then(
          () => finish(
            undefined,
            typeof message.result?.userAgent === "string"
              ? message.result.userAgent
              : undefined,
          ),
          finish,
        );
      });
      const removeClose = transport.onClose((error) => {
        finish(error ?? new Error("App Server Transport 在握手完成前关闭"));
      });
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        removeMessage();
        removeClose();
        if (error) rejectPromise(error);
        else resolvePromise(response);
      };
      void transport.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex_connect",
            title: "Codex Connect Doctor",
            version: packageMetadata.version,
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: null,
          },
        },
      })).catch(finish);
    });
  } finally {
    await transport.close();
  }
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
