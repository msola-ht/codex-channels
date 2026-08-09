import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

import WebSocket from "ws";

import {
  readGatewayConfig,
  validateGatewayConfigDocument,
} from "../runtime/gateway-config.mjs";
import {
  loadManagedProviderAppServer,
  providerAppServerSocketPath,
  validateConfiguredModelProvider,
} from "../runtime/model-provider-runtime.mjs";
import { readApiProviderKey } from "../runtime/api-provider-credential.mjs";
import { validateFeishuApplication } from "./feishu-application.mjs";
import { packageDir, resolveConfiguredPath, runtimeConfig, userDataDir } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const checks = [];
let checkSection = "基础环境";
if (process.argv.length > 2) {
  throw new Error("用法：codexc doctor");
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
  const bubblewrap = optionalExecutable("bwrap");
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
    checkMode("配置目录权限", dataDir, 0o700);
  }
  checkMode("配置文件权限", configPath, 0o600);
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
  setSection("通讯渠道");
  const telegram = table(document.telegram);
  const feishu = table(document.feishu);
  const weixin = table(document.weixin);
  const codex = table(document.codex);
  const storage = table(document.storage);
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
      const stateDatabasePath = resolveConfiguredPath(
        stringValue(storage.database_path),
        dataDir,
        join(dataDir, "data", "gateway.sqlite3"),
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
  const vision = table(document.vision);
  if (vision.mode === "responses_api") {
    note("图片识别", `使用第三方 API 提供商 ${String(vision.provider)}`);
  } else {
    note("图片识别", "未启用");
  }

  setSection("Workspace");
  try {
    const { workspaces, defaultWorkspace } = readWorkspaceConfig(document);
    record("Workspace", true, `${workspaces.length} 个，默认 ${defaultWorkspace.id}`);
  } catch (error) {
    record("Workspace", false, errorMessage(error));
  }

  setSection("Codex 与 App Server");
  const codexCommand = stringValue(codex.binary) || "codex";
  try {
    const codexBinary = resolveExecutable(codexCommand);
    const versionResult = spawnSync(codexBinary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
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

  const socketPath = resolveConfiguredPath(
    stringValue(codex.socket_path),
    dataDir,
    join(dataDir, "runtime", "codex-app-server.sock"),
  );
  await checkAppServer("Codex App Server", socketPath);
  try {
    const configuredProvider = validateConfiguredModelProvider(process.env);
    if (configuredProvider) {
      record(
        "模型提供商配置",
        true,
        `${configuredProvider.provider} ${configuredProvider.mode === "switching" ? "切换" : "固定"}模式有效`,
      );
    }
    const managedProvider = loadManagedProviderAppServer(process.env);
    if (managedProvider) {
      await checkAppServer(
        `${managedProvider.provider} App Server`,
        providerAppServerSocketPath(socketPath, managedProvider.provider),
      );
    }
  } catch (error) {
    record("模型提供商配置", false, errorMessage(error));
  }
}

async function checkAppServer(label, socketPath) {
  if (!existsSync(socketPath)) {
    record(label, false, `Socket 不存在：${socketPath}`);
    return;
  }
  try {
    const appServerUserAgent = await initializeUnixWebSocket(socketPath);
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
  const labels = ["com.hegenai.codex-app-server", "com.hegenai.codex-gateway"];
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
  const units = ["codex-connect-app-server.service", "codex-connect-gateway.service"];
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
        : "未启用或无法确认；如需退出 SSH 后继续运行，请执行 sudo loginctl enable-linger $USER",
    );
  }
} else {
  note("系统服务", "当前平台尚未提供系统服务适配");
}

const visibleChecks = checks.filter((check) => check.kind !== "success");
const colorsEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
console.log("Codex Connect Doctor");
let renderedSection;
for (const check of visibleChecks) {
  if (check.section !== renderedSection) {
    renderedSection = check.section;
    console.log(`\n=== ${renderedSection} ===`);
  }
  console.log(`${coloredPrefix(check)} ${check.name}：${check.detail}`);
  if (check.remediation) {
    console.log(`${colorize("[处理]", 36)} ${check.name}：${check.remediation}`);
  }
}
const failures = checks.filter((check) => check.kind === "failure").length;
const successes = checks.filter((check) => check.kind === "success").length;
const notes = checks.filter((check) => check.kind === "note").length;
console.log(
  failures === 0
    ? `\n诊断通过：${successes} 项通过，${notes} 项提示。`
    : `\n诊断发现 ${failures} 项问题：${successes} 项通过，${notes} 项提示。`,
);
process.exitCode = failures === 0 ? 0 : 1;

function setSection(section) {
  checkSection = section;
}

function coloredPrefix(check) {
  return colorize(check.prefix, check.kind === "failure" ? 31 : 33);
}

function colorize(value, color) {
  return colorsEnabled ? `\u001b[${color}m${value}\u001b[0m` : value;
}

function record(name, passed, detail) {
  checks.push({
    section: checkSection,
    kind: passed ? "success" : "failure",
    prefix: passed ? "[通过]" : "[失败]",
    name,
    detail,
  });
}

function note(name, detail, remediation) {
  checks.push({ section: checkSection, kind: "note", prefix: "[提示]", name, detail, remediation });
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

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveExecutable(command) {
  if (isAbsolute(command)) {
    return realpathSync(command);
  }
  return realpathSync(execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim());
}

function optionalExecutable(command) {
  try {
    const result = spawnSync("/usr/bin/which", [command], {
      encoding: "utf8",
      timeout: 3_000,
    });
    if (result.status !== 0) {
      return undefined;
    }
    const path = result.stdout.trim();
    return path ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
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
              name: "codexc_doctor",
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
