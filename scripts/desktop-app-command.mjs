import { spawn, spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { inspectAppServerSupervisorState } from "../runtime/app-server-supervisor.mjs";
import { macDesktopAppPluginEnabledConfigKey } from "../runtime/desktop-app-host.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import {
  loadOrCreateDesktopAppBridgeToken,
  readDesktopAppBridgeToken,
} from "../runtime/desktop-app-bridge.mjs";
import {
  readGatewayConfig,
  validateGatewayConfigDocument,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { writeCliMessage as printCliMessage } from "../runtime/cli-presentation.mjs";
import { locateUserConfig, requireUserConfig } from "./runtime-config.mjs";
import { runServiceCommand } from "./service-command.mjs";

const defaultBridgePort = 47_821;
const compatibilityMarker = Buffer.from("CODEX_APP_SERVER_WS_URL", "utf8");
const macCompatibilityMarkers = [
  Buffer.from("CODEX_APP_SERVER_FORCE_CLI", "utf8"),
  Buffer.from("CODEX_CLI_PATH", "utf8"),
  Buffer.from("CODEX_APP_TOOLS_PIPE_PATH", "utf8"),
  Buffer.from(macDesktopAppPluginEnabledConfigKey, "utf8"),
];
const bridgePath = "/codex-app-server";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopAppProxyPath = join(scriptDirectory, "desktop-app-proxy.mjs");

export const desktopAppCommandUsage = `用法：codexc desktop-app <enable|disable|status|open>

  enable [--port 端口]   启用 Desktop App 共享连接并重启 App Server 服务
  disable                禁用共享连接并重启 App Server 服务
  status [--json]        只读检查 Desktop、配置和连接状态
  open                   通过共享 App Server 启动 Desktop App`;

export async function runDesktopAppCommand(args, options = {}) {
  const parsed = parseDesktopAppArgs(args);
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const output = options.output ?? process.stdout;
  const writeMessage = options.writeMessage ?? printCliMessage;
  const inspectDesktopApp = options.inspectDesktopApp
    ?? (() => inspectDesktopAppForPlatform(platform, environment));
  const restartAppServer = options.restartAppServer
    ?? (() => runServiceCommand(["restart", "app-server"]));
  const probeBridge = options.probeBridge ?? probeDesktopAppBridge;
  const inspectSupervisorState = options.inspectSupervisorState
    ?? inspectAppServerSupervisorState;
  const openDesktop = options.openDesktop
    ?? (platform === "win32"
      ? (path, endpoint) => openWindowsDesktopApp(path, endpoint, { environment })
      : openMacDesktopApp);
  const located = parsed.action === "status"
    ? locateUserConfig(environment)
    : requireUserConfig(environment);
  const document = readGatewayConfig(located.configPath);
  const codex = table(document.codex);
  const runtimeEnvironment = {
    ...environment,
    CODEX_CONNECT_HOME: located.dataDir,
    CODEX_CONNECT_CONFIG_FILE: located.configPath,
    CODEX_BINARY: stringValue(codex.binary) || "codex",
  };
  const appServer = resolveAppServerRuntime(document, located.dataDir, runtimeEnvironment);
  const desktopConfig = desktopAppConfig(codex.desktop_app);
  const supported = platform === "darwin" || platform === "win32";
  const app = supported
    ? inspectDesktopApp()
    : unsupportedDesktopApp();

  if (parsed.action === "status") {
    const status = await readDesktopAppStatus({
      platform,
      supported,
      app,
      desktopConfig,
      primaryProvider: appServer.primaryProvider,
      primarySocketPath: appServer.primarySocketPath,
      dataDir: located.dataDir,
      probeBridge,
      inspectSupervisorState,
    });
    if (parsed.json) {
      output.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      writeDesktopAppStatus(status, writeMessage);
    }
    return status;
  }

  if (!supported) {
    throw new Error("Codex Desktop App 共享当前只支持 macOS 与 Windows");
  }
  if (parsed.action === "open" || parsed.action === "enable") {
    assertDesktopAppCompatible(app);
  }
  if (app.running !== false) {
    throw new Error(app.running
      ? "请先完全退出 ChatGPT Desktop App 后再继续"
      : "无法确认 ChatGPT Desktop App 是否已退出");
  }

  if (parsed.action === "open") {
    if (appServer.primaryProvider !== "openai") {
      throw new Error("Codex Desktop App 共享只支持 OpenAI 主 Provider");
    }
    if (desktopConfig?.enabled !== true) {
      throw new Error("Codex Desktop App 共享尚未启用，请先运行 codexc desktop-app enable");
    }
    if (platform === "darwin") {
      await assertMacDesktopAppHostReady(
        appServer.primarySocketPath,
        inspectSupervisorState,
      );
      writeMessage("note", "启动时会短暂重启主 App Server；请确认当前没有活动 Turn。");
      await openDesktop(app.path, "");
    } else {
      const token = readDesktopAppBridgeToken(located.dataDir);
      const endpoint = privateBridgeEndpoint(desktopConfig.port, token);
      if (!await probeBridge(endpoint)) {
        throw new Error("Codex Desktop App 桥未就绪，请运行 codexc service restart app-server");
      }
      await openDesktop(app.path, endpoint);
    }
    writeMessage("success", "ChatGPT Desktop App 已通过共享 App Server 启动。");
    return { action: "open", opened: true };
  }

  if (parsed.action === "enable") {
    if (appServer.primaryProvider !== "openai") {
      throw new Error("Codex Desktop App 共享只支持 OpenAI 主 Provider");
    }
    const port = parsed.port ?? desktopConfig?.port ?? defaultBridgePort;
    const token = platform === "darwin"
      ? undefined
      : loadOrCreateDesktopAppBridgeToken(located.dataDir);
    const applied = { enabled: true, port };
    const previous = writeDesktopAppConfig(located.configPath, applied);
    try {
      await restartAppServer();
      if (platform === "darwin") {
        await assertMacDesktopAppHostReady(
          appServer.primarySocketPath,
          inspectSupervisorState,
        );
      } else if (token !== undefined && !await probeBridge(privateBridgeEndpoint(port, token))) {
        throw new Error("Codex Desktop App 桥在服务重启后未就绪");
      }
    } catch (error) {
      await rollbackDesktopAppConfig({
        configPath: located.configPath,
        previous,
        applied,
        restartAppServer,
        cause: error,
      });
    }
    writeMessage("success", "Codex Desktop App 共享已启用。");
    writeMessage("note", "请使用 codexc desktop-app open 启动 ChatGPT Desktop App。");
    return { action: "enable", enabled: true, port };
  }

  if (desktopConfig === undefined) {
    writeMessage("note", "Codex Desktop App 共享已经处于禁用状态。");
    return { action: "disable", enabled: false };
  }
  const previous = writeDesktopAppConfig(located.configPath, undefined);
  try {
    await restartAppServer();
  } catch (error) {
    await rollbackDesktopAppConfig({
      configPath: located.configPath,
      previous,
      applied: undefined,
      restartAppServer,
      cause: error,
    });
  }
  writeMessage("success", "Codex Desktop App 共享已禁用。");
  return { action: "disable", enabled: false };
}

async function assertMacDesktopAppHostReady(primarySocketPath, inspectSupervisorState) {
  const inspection = await inspectSupervisorState(primarySocketPath);
  if (
    inspection.status !== "ready"
    || inspection.topology.desktopAppHostProtocolVersion !== 1
  ) {
    throw new Error(
      "App Server 服务不支持当前 Desktop Host；请运行 codexc service restart app-server 后重试",
    );
  }
}

export function inspectMacDesktopApp({
  environment = process.env,
  candidates = [
    "/Applications/ChatGPT.app",
    join(environment.HOME || homedir(), "Applications", "ChatGPT.app"),
  ],
} = {}) {
  for (const path of candidates) {
    let bundle;
    try {
      bundle = lstatSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!bundle.isDirectory() || bundle.isSymbolicLink()) {
      return desktopAppFailure(path, "ChatGPT.app 不是普通应用目录");
    }
    const resourcesPath = join(path, "Contents", "Resources", "app.asar");
    const infoPath = join(path, "Contents", "Info.plist");
    let compatible;
    try {
      compatible = macCompatibilityMarkers.every((marker) =>
        fileContainsMarker(resourcesPath, marker));
    } catch {
      return desktopAppFailure(path, "无法读取 ChatGPT Desktop App 资源");
    }
    return {
      installed: true,
      path,
      version: readMacBundleVersion(infoPath),
      running: macApplicationStatus(path),
      compatible,
      reason: compatible ? null : "当前 Desktop 构建缺少共享 App Server 兼容入口",
    };
  }
  return {
    installed: false,
    path: null,
    version: null,
    running: false,
    compatible: false,
    reason: "未找到 /Applications/ChatGPT.app 或 ~/Applications/ChatGPT.app",
  };
}

export function inspectWindowsDesktopApp({
  environment = process.env,
  inspectInstallation = () => inspectWindowsDesktopInstallation(environment),
} = {}) {
  let installation;
  try {
    installation = inspectInstallation();
  } catch {
    return {
      installed: false,
      path: null,
      version: null,
      running: null,
      compatible: false,
      reason: "无法查询当前用户的 OpenAI.Codex 安装包",
    };
  }
  if (installation?.installed !== true) {
    return {
      installed: false,
      path: null,
      version: null,
      running: false,
      compatible: false,
      reason: "当前用户未安装 OpenAI.Codex Desktop 包",
    };
  }
  const executablePath = stringValue(installation.executablePath);
  const resourcePath = stringValue(installation.resourcePath);
  if (!executablePath || !regularFile(executablePath)) {
    return desktopAppFailure(null, "OpenAI.Codex 包内未找到正式 Desktop 可执行文件");
  }
  let compatible;
  try {
    compatible = Boolean(resourcePath)
      && fileContainsMarker(resourcePath, compatibilityMarker);
  } catch {
    return desktopAppFailure(executablePath, "无法读取 OpenAI.Codex Desktop 资源");
  }
  return {
    installed: true,
    path: executablePath,
    version: stringValue(installation.version) || null,
    running: typeof installation.running === "boolean" ? installation.running : null,
    compatible,
    reason: compatible ? null : "当前 Desktop 构建缺少共享 App Server 兼容入口",
  };
}

export function openWindowsDesktopApp(
  path,
  endpoint,
  {
    environment = process.env,
    spawnProcess = spawn,
    startupConfirmationMs = 1_000,
  } = {},
) {
  const childEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name.toLowerCase() !== "codex_app_server_ws_url") {
      childEnvironment[name] = value;
    }
  }
  childEnvironment.CODEX_APP_SERVER_WS_URL = endpoint;

  return new Promise((resolveLaunch, rejectLaunch) => {
    let child;
    try {
      child = spawnProcess(path, [], {
        cwd: dirname(path),
        detached: true,
        env: childEnvironment,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      rejectLaunch(new Error("OpenAI.Codex Desktop 启动失败"));
      return;
    }
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("error", reject);
      child.removeListener("exit", handleExit);
    };
    const reject = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectLaunch(new Error("OpenAI.Codex Desktop 启动失败"));
    };
    const resolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      child.unref();
      resolveLaunch();
    };
    const handleExit = () => reject();
    child.once("error", reject);
    child.once("exit", handleExit);
    child.once("spawn", () => {
      if (startupConfirmationMs === 0) {
        resolve();
        return;
      }
      timer = setTimeout(resolve, startupConfirmationMs);
    });
  });
}

function parseDesktopAppArgs(args) {
  const [action, ...rest] = args;
  if (action === "status") {
    if (rest.length === 0) return { action, json: false };
    if (rest.length === 1 && rest[0] === "--json") return { action, json: true };
  }
  if (action === "enable") {
    if (rest.length === 0) return { action };
    if (rest.length === 2 && rest[0] === "--port") {
      const port = Number(rest[1]);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
        return { action, port };
      }
    }
  }
  if ((action === "disable" || action === "open") && rest.length === 0) {
    return { action };
  }
  throw new Error(desktopAppCommandUsage);
}

async function readDesktopAppStatus({
  platform,
  supported,
  app,
  desktopConfig,
  primaryProvider,
  primarySocketPath,
  dataDir,
  probeBridge,
  inspectSupervisorState,
}) {
  let tokenReady = false;
  let bridgeReady = false;
  let toolHostSupported = false;
  let toolHostAttached = false;
  if (
    platform === "win32"
    && desktopConfig?.enabled === true
    && primaryProvider === "openai"
  ) {
    try {
      const token = readDesktopAppBridgeToken(dataDir);
      tokenReady = true;
      bridgeReady = await probeBridge(privateBridgeEndpoint(desktopConfig.port, token));
    } catch {
      tokenReady = false;
    }
  }
  if (platform === "darwin" && desktopConfig?.enabled === true) {
    try {
      const inspection = await inspectSupervisorState(primarySocketPath);
      toolHostSupported = inspection.status === "ready"
        && inspection.topology.desktopAppHostProtocolVersion === 1;
      toolHostAttached = toolHostSupported
        && inspection.topology.desktopAppAttached === true;
    } catch {
      toolHostAttached = false;
    }
  }
  return {
    platform,
    supported,
    supportLevel: supported ? "preview" : "unsupported",
    installed: app.installed,
    path: app.path,
    version: app.version,
    running: app.running,
    compatible: app.compatible,
    compatibilityReason: app.reason,
    configured: desktopConfig?.enabled === true,
    port: platform === "win32" ? desktopConfig?.port ?? null : null,
    endpoint: platform === "win32" && desktopConfig?.port
      ? `ws://127.0.0.1:${desktopConfig.port}${bridgePath}`
      : null,
    primaryProvider,
    tokenReady,
    bridgeReady,
    toolHostSupported,
    toolHostAttached,
    launchMode: supported ? "per-launch-environment" : "unsupported",
  };
}

function writeDesktopAppStatus(status, writeMessage) {
  writeMessage(status.supported ? "note" : "failure", `平台：${status.platform}（${status.supportLevel}）`);
  writeMessage(status.installed ? "success" : "failure", status.installed
    ? `Desktop：已安装${status.version ? `（${status.version}）` : ""}`
    : `Desktop：未安装；${status.compatibilityReason}`);
  if (status.installed) {
    writeMessage(status.compatible ? "success" : "failure", status.compatible
      ? "兼容入口：可用"
      : `兼容入口：不可用；${status.compatibilityReason}`);
    writeMessage("note", `运行状态：${
      status.running === null ? "unknown" : status.running ? "running" : "stopped"
    }`);
  }
  if (!status.supported && status.configured) {
    writeMessage("failure", "共享配置：unsupported（当前平台不支持）");
  } else {
    writeMessage(status.configured ? "success" : "note", `共享配置：${status.configured
      ? status.platform === "darwin" ? "enabled（受管 stdio）" : `enabled（端口 ${status.port}）`
      : "disabled"}`);
  }
  if (status.configured && status.supported) {
    if (status.platform === "darwin") {
      writeMessage(status.toolHostSupported ? "success" : "failure", `受管入口：${
        status.toolHostSupported ? "ready" : "not-ready"
      }`);
      writeMessage(status.toolHostAttached ? "success" : "note", `内置工具 Host：${
        status.toolHostAttached ? "attached" : "not-attached"
      }`);
    } else {
      writeMessage(status.bridgeReady ? "success" : "failure", `共享桥：${
        status.bridgeReady ? "ready" : "not-ready"
      }`);
    }
  }
}

function writeDesktopAppConfig(configPath, next) {
  const document = readGatewayConfig(configPath);
  const codex = table(document.codex);
  const previous = desktopAppConfig(codex.desktop_app);
  if (next === undefined) {
    delete codex.desktop_app;
  } else {
    codex.desktop_app = next;
  }
  document.codex = codex;
  validateGatewayConfigDocument(document);
  writeGatewayConfig(configPath, document);
  return previous;
}

async function rollbackDesktopAppConfig({
  configPath,
  previous,
  applied,
  restartAppServer,
  cause,
}) {
  let rollbackError;
  try {
    const document = readGatewayConfig(configPath);
    const codex = table(document.codex);
    const current = desktopAppConfig(codex.desktop_app);
    if (JSON.stringify(current) !== JSON.stringify(applied)) {
      throw new Error("config.toml 在 Desktop App 配置回滚前已发生变化");
    }
    if (previous === undefined) delete codex.desktop_app;
    else codex.desktop_app = previous;
    document.codex = codex;
    validateGatewayConfigDocument(document);
    writeGatewayConfig(configPath, document);
    await restartAppServer();
  } catch (error) {
    rollbackError = error;
  }
  if (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      "Codex Desktop App 配置失败，且回滚未完全完成",
      { cause: rollbackError },
    );
  }
  throw cause;
}

function assertDesktopAppCompatible(app) {
  if (!app.installed || !app.compatible || !app.path) {
    throw new Error(app.reason || "ChatGPT Desktop App 不兼容");
  }
}

function desktopAppConfig(value) {
  const candidate = table(value);
  if (candidate.enabled !== true && candidate.enabled !== false) return undefined;
  if (!Number.isInteger(candidate.port)) return undefined;
  return { enabled: candidate.enabled, port: candidate.port };
}

function unsupportedDesktopApp() {
  return {
    installed: false,
    path: null,
    version: null,
    running: false,
    compatible: false,
    reason: "当前平台没有受支持的 Codex Desktop App",
  };
}

function desktopAppFailure(path, reason) {
  return {
    installed: true,
    path,
    version: null,
    running: false,
    compatible: false,
    reason,
  };
}

function inspectDesktopAppForPlatform(platform, environment) {
  if (platform === "darwin") return inspectMacDesktopApp({ environment });
  if (platform === "win32") return inspectWindowsDesktopApp({ environment });
  return unsupportedDesktopApp();
}

function inspectWindowsDesktopInstallation(environment) {
  let invocation;
  try {
    invocation = resolveExecutableInvocation(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(scriptDirectory, "windows-desktop-app-inspect.ps1"),
      ],
      environment,
    );
  } catch {
    throw new Error("Windows Desktop 探测需要 PowerShell 7（pwsh）");
  }
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 1_048_576,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Windows Desktop 安装包查询失败");
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Windows Desktop 安装包查询返回无效");
  }
}

function readMacBundleVersion(infoPath) {
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPath],
    { encoding: "utf8", maxBuffer: 1_048_576 },
  );
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function macApplicationStatus(appPath) {
  const result = spawnSync("/usr/bin/osascript", [
    "-e",
    "on run argv",
    "-e",
    "application (item 1 of argv) is running",
    "-e",
    "end run",
    appPath,
  ], { encoding: "utf8", maxBuffer: 1_048_576 });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  const status = result.stdout.trim();
  if (status === "true") return true;
  if (status === "false") return false;
  return null;
}

function openMacDesktopApp(path) {
  const resourcesPath = join(path, "Contents", "Resources");
  const nodePath = join(resourcesPath, "cua_node", "bin", "node");
  const result = spawnSync(
    "/usr/bin/open",
    [
      "--env",
      "CODEX_APP_SERVER_FORCE_CLI=1",
      "--env",
      `CODEX_CLI_PATH=${desktopAppProxyPath}`,
      "--env",
      `CODEX_ELECTRON_RESOURCES_PATH=${resourcesPath}`,
      "--env",
      `CODEX_MCP_NODE_PATH=${nodePath}`,
      "--env",
      `CODEX_BROWSER_USE_NODE_PATH=${nodePath}`,
      "-a",
      path,
    ],
    { stdio: "ignore" },
  );
  if (result.error || result.status !== 0) {
    throw new Error("ChatGPT Desktop App 启动失败");
  }
}

function fileContainsMarker(path, marker) {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) return false;
  const descriptor = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  try {
    while (true) {
      const bytes = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytes === 0) return false;
      const current = Buffer.concat([carry, chunk.subarray(0, bytes)]);
      if (current.includes(marker)) return true;
      carry = current.subarray(Math.max(0, current.length - marker.length + 1));
    }
  } finally {
    closeSync(descriptor);
  }
}

function regularFile(path) {
  try {
    const status = lstatSync(path);
    return status.isFile() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}

function probeDesktopAppBridge(endpoint, timeoutMs = 3_000) {
  return new Promise((resolvePromise) => {
    const socket = new WebSocket(endpoint, {
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
    });
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.once("error", () => undefined);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
      resolvePromise(ready);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("unexpected-response", () => finish(false));
  });
}

function privateBridgeEndpoint(port, token) {
  return `ws://127.0.0.1:${port}${bridgePath}?token=${encodeURIComponent(token)}`;
}

function table(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
