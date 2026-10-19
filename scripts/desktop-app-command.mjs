import { desktopAppCommandUsage } from "./cli-command-usage.mjs";
export { desktopAppCommandUsage } from "./cli-command-usage.mjs";
import { spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { aggregateProviderId } from "../runtime/aggregate-model-provider.mjs";
import {
  acquireAppServerProviderLease,
  inspectAppServerSupervisorState,
} from "../runtime/app-server-supervisor.mjs";
import { macDesktopAppPluginEnabledConfigKey } from "../runtime/desktop-app-host.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { codexProcessInvocation } from "../runtime/owned-process.mjs";
import { childProcessIsRunning, registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";
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
import { runRestartCommand } from "./service-command.mjs";
import { createPrompter } from "./terminal-prompter.mjs";
import { resolveProviderSelection } from "./provider-selection.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";
import { supervisedCliInvocation } from "./cli-command-worker.mjs";

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
const desktopCommandTimeoutMs = 15_000;
const maximumDesktopCommandOutputBytes = 1_048_576;

export async function runDesktopAppCommand(args, options = {}) {
  const parsed = parseDesktopAppArgs(args);
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const supported = platform === "darwin" || platform === "win32";
  if (parsed.action !== "status" && !supported) {
    throw new Error("Codex Desktop App 共享当前只支持 macOS 与 Windows");
  }
  if (parsed.port !== undefined && platform !== "win32") {
    throw new Error("--port 仅用于 Windows Desktop 共享桥；macOS 使用受管 stdio，无需设置端口");
  }
  const output = options.output ?? process.stdout;
  const writeMessage = options.writeMessage ?? printCliMessage;
  const inspectDesktopApp = options.inspectDesktopApp
    ?? (({ signal } = {}) => inspectDesktopAppForPlatform(platform, environment, signal));
  const restartAppServer = options.restartAppServer
    ?? (() => runRestartCommand(["appserver"]));
  const probeBridge = options.probeBridge ?? probeDesktopAppBridge;
  const inspectSupervisorState = options.inspectSupervisorState
    ?? inspectAppServerSupervisorState;
  const acquireProviderLease = options.acquireProviderLease
    ?? acquireAppServerProviderLease;
  const openDesktop = options.openDesktop
    ?? (platform === "win32"
      ? (path, endpoint, _provider, { signal } = {}) => openWindowsDesktopApp(path, endpoint, { environment, signal })
      : openMacDesktopApp);
  const located = parsed.action === "status"
    ? locateUserConfig(environment)
    : requireUserConfig(environment);
  const document = validateGatewayConfigDocument(readGatewayConfig(located.configPath));
  const codex = table(document.codex);
  const runtimeEnvironment = {
    ...environment,
    CODEX_CONNECT_HOME: located.dataDir,
    CODEX_CONNECT_CONFIG_FILE: located.configPath,
    CODEX_BINARY: stringValue(codex.binary) || "codex",
  };
  const appServer = resolveAppServerRuntime(document, located.dataDir, runtimeEnvironment);
  const selectedProvider = parsed.provider === undefined ? appServer.primaryProvider
    : resolveProviderSelection(parsed.provider, { environment: runtimeEnvironment }).provider;
  const selectedSocketPath = resolveDesktopAppSocketPath(appServer, selectedProvider);
  let desktopConfig = desktopAppConfig(codex.desktop_app);
  const progressOptions = { output: parsed.json ? null : output, delayMs: 250, signal: options.signal };
  const app = supported
    ? await withCliProgress("检查 Desktop 安装与运行状态", ({ signal }) => inspectDesktopApp({ signal }), progressOptions)
    : unsupportedDesktopApp();

  if (parsed.action === "status") {
    const status = await withCliProgress("读取 Desktop 共享入口状态", () => readDesktopAppStatus({
      platform,
      supported,
      app,
      desktopConfig,
      primaryProvider: appServer.primaryProvider,
      primarySocketPath: appServer.primarySocketPath,
      selectedProvider,
      dataDir: located.dataDir,
      inspectSupervisorState,
    }), progressOptions);
    if (parsed.json) {
      output.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      writeDesktopAppStatus(status, writeMessage);
    }
    return status;
  }

  if (parsed.action === "open" || parsed.action === "enable") {
    assertDesktopAppCompatible(app);
  }
  if (app.running !== false) {
    throw new Error(app.running
      ? "请先完全退出 ChatGPT Desktop App 后再继续"
      : "无法确认 ChatGPT Desktop App 是否已退出");
  }

  async function withStartupLease(provider, operation, progress) {
    let lease;
    try {
      progress.signal.throwIfAborted();
      progress.message(`等待 Provider ${provider} 的临时实例租约`);
      lease = await acquireProviderLease(appServer.primarySocketPath, provider);
    } catch {
      progress.signal.throwIfAborted();
      throw new Error(`Provider ${provider} 的 App Server 未能就绪；请查看 App Server 服务状态与日志`);
    }
    let operationFailed = false;
    let operationError;
    try {
      progress.signal.throwIfAborted();
      await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      progress.message(`释放 Provider ${provider} 的临时实例租约`);
      await lease.close();
    } catch (error) {
      if (operationFailed) {
        throw new AggregateError([operationError, error], `Provider ${provider} 的启动检查或桌面启动失败，且临时租约未能释放`, { cause: error });
      }
      throw new Error(`无法释放 Provider ${provider} 的启动检查租约；请检查 App Server 服务状态`, { cause: error });
    }
    if (operationFailed) throw operationError;
  }

  async function enableSharing(port) {
    const token = platform === "darwin" ? undefined : loadOrCreateDesktopAppBridgeToken(located.dataDir);
    const applied = { enabled: true, port };
    const previous = writeDesktopAppConfig(located.configPath, applied);
    let phase = "重启 App Server";
    try {
      await restartAppServer();
      phase = "确认 Desktop 共享入口就绪";
      await withCliProgress(phase, async (progress) => {
        if (platform === "darwin") {
          await assertMacDesktopAppHostReady(appServer.primarySocketPath, inspectSupervisorState);
        } else if (token !== undefined) {
          await assertDesktopAppProviderSelectionReady(appServer.primarySocketPath, inspectSupervisorState);
          progress.signal.throwIfAborted();
          await withStartupLease(appServer.primaryProvider, async () => {
            progress.message("检查 Desktop 共享桥连接");
            if (!await probeBridge(privateBridgeEndpoint(port, token, appServer.primaryProvider), { signal: progress.signal })) {
              throw new Error("Codex Desktop App 桥在服务重启后未就绪");
            }
          }, progress);
        }
      }, progressOptions);
    } catch (error) {
      await rollbackDesktopAppConfig({ configPath: located.configPath, previous, applied, restartAppServer, cause: error, phase });
    }
    desktopConfig = applied;
  }

  if (parsed.action === "open") {
    if (appServer.primaryProvider !== "openai") {
      throw new Error("Codex Desktop App 共享只支持 OpenAI 主 Provider");
    }
    if (desktopConfig?.enabled !== true) {
      const confirmed = await (options.confirmEnable ?? confirmDesktopAppEnable)();
      if (confirmed !== true) {
        writeMessage("note", "已取消启动；共享配置和服务未改动。");
        return { action: "open", opened: false };
      }
      await enableSharing(desktopConfig?.port ?? defaultBridgePort);
    }
    if (platform === "darwin") {
      const inspectActiveThreads = options.inspectActiveThreads
        ?? inspectMacDesktopAppActiveThreads;
      await withCliProgress("检查 Desktop 启动条件", async (progress) => {
        const topology = await assertMacDesktopAppHostReady(
          appServer.primarySocketPath,
          inspectSupervisorState,
        );
        if (topology.desktopAppAttached === true) {
          throw new Error("现有 Codex Desktop App Host 租约尚未释放；请稍后重试");
        }
        if (topology.leasedProviders.includes(selectedProvider)) {
          throw new Error(
            `Provider ${selectedProvider} 的 App Server 正由原生客户端租约保护；请退出相关客户端后重试`,
          );
        }
        await withStartupLease(selectedProvider, async () => {
          progress.message(`读取 Provider ${selectedProvider} 的活动 Thread`);
          let activeThreadCount;
          try {
            activeThreadCount = await inspectActiveThreads({
              socketPath: selectedSocketPath,
              codexBinary: runtimeEnvironment.CODEX_BINARY,
              signal: progress.signal,
            });
          } catch (error) {
            progress.signal.throwIfAborted();
            if (error instanceof DesktopAppPreflightError) throw error;
            throw new DesktopAppPreflightError("activity");
          }
          if (!Number.isSafeInteger(activeThreadCount) || activeThreadCount < 0) {
            throw new DesktopAppPreflightError("activity");
          }
          if (activeThreadCount > 0) {
            throw new Error(
              `Provider ${selectedProvider} 的 App Server 当前有 ${activeThreadCount} 个活动 Thread；`
              + "请等待 Turn 完成后重试",
            );
          }
        }, progress);
      }, progressOptions);
      writeMessage("note", `已确认 Provider ${selectedProvider} 当前没有活动 Turn；启动时会短暂重启该 Provider 的 App Server。`);
      await withCliProgress("发送 Desktop 启动请求", ({ signal }) =>
        openDesktop(app.path, "", selectedProvider, { signal }), progressOptions);
    } else {
      await withCliProgress("检查并启动 Desktop", async (progress) => {
        await assertDesktopAppProviderSelectionReady(appServer.primarySocketPath, inspectSupervisorState);
        const token = readDesktopAppBridgeToken(located.dataDir);
        const endpoint = privateBridgeEndpoint(desktopConfig.port, token, selectedProvider);
        await withStartupLease(selectedProvider, async () => {
          progress.message(`检查 Provider ${selectedProvider} 的 Desktop 共享桥`);
          if (!await probeBridge(endpoint, { signal: progress.signal })) {
            throw new Error(`Provider ${selectedProvider} 已就绪，但 Desktop App 桥连接失败；请检查桥配置与 App Server 服务日志`);
          }
          progress.signal.throwIfAborted();
          progress.message("发送 Desktop 启动请求");
          await openDesktop(app.path, endpoint, selectedProvider, { signal: progress.signal });
        }, progress);
      }, progressOptions);
    }
    writeMessage("success", `已发送 ChatGPT Desktop App 启动请求，目标为 Provider ${selectedProvider} 的共享 App Server；本次选择不保存。`);
    writeMessage("note", "启动请求成功不代表 Desktop 已连接或内置 MCP 工具已就绪；请检查 App 内状态。");
    return { action: "open", opened: true, provider: selectedProvider };
  }

  if (parsed.action === "enable") {
    if (appServer.primaryProvider !== "openai") {
      throw new Error("Codex Desktop App 共享只支持 OpenAI 主 Provider");
    }
    const port = parsed.port ?? desktopConfig?.port ?? defaultBridgePort;
    await enableSharing(port);
    writeMessage("success", "Codex Desktop App 共享已启用。");
    writeMessage("note", "请使用 codexc app 启动 ChatGPT Desktop App。");
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
      phase: "禁用共享后重启 App Server",
    });
  }
  writeMessage("success", "Codex Desktop App 共享已禁用。");
  return { action: "disable", enabled: false };
}

async function confirmDesktopAppEnable() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("首次启动需要在本机终端确认启用共享；非交互使用请先显式运行 codexc app enable");
  }
  const prompts = createPrompter(process.stdin, process.stdout);
  try {
    return await prompts.confirm("首次启动将启用共享并重启 App Server，现有连接与进行中的任务可能中断。是否继续？", false);
  } finally {
    prompts.close();
  }
}

async function assertMacDesktopAppHostReady(primarySocketPath, inspectSupervisorState) {
  let inspection;
  try {
    inspection = await inspectSupervisorState(primarySocketPath);
  } catch {
    throw new Error("无法读取 App Server 受管入口状态；已取消启动");
  }
  if (
    inspection.status !== "ready"
    || inspection.topology.desktopAppHostProtocolVersion !== 2
    || inspection.topology.desktopAppProviderProtocolVersion !== 1
  ) {
    throw new Error(
      "App Server 服务不支持当前 Desktop Host；请运行 codexc restart appserver 后重试",
    );
  }
  return inspection.topology;
}

async function assertDesktopAppProviderSelectionReady(primarySocketPath, inspectSupervisorState) {
  let inspection;
  try {
    inspection = await inspectSupervisorState(primarySocketPath);
  } catch {
    throw new Error("无法读取 App Server 受管入口状态；已取消启动");
  }
  if (inspection.status !== "ready" || inspection.topology.desktopAppProviderProtocolVersion !== 1) {
    throw new Error("App Server 服务不支持当前 Desktop Provider 选择；请运行 codexc restart appserver 后重试");
  }
}

async function inspectMacDesktopAppActiveThreads({ socketPath, codexBinary, signal }) {
  signal?.throwIfAborted();
  const {
    CodexAppServerClient,
    createAppServerTransport,
    JsonRpcClient,
  } = await import("../dist/codex-client/index.js");
  const transport = createAppServerTransport(
    { kind: "local-app-server", socketPath },
    {
      createCodexProcessInvocation: args => codexProcessInvocation(codexBinary, args),
      terminateCodexProcess: terminateChildProcess,
      connectTimeoutMs: 3_000,
    },
  );
  const client = new CodexAppServerClient(
    new JsonRpcClient(
      transport,
      10_000,
      undefined,
      64,
      { name: "codex_app_server_daemon", title: "Codex Desktop App launch check" },
    ),
    {},
  );
  let closeTask;
  const close = () => {
    closeTask ??= client.close();
    // Closing rejects pending RPC work; the finally below observes cleanup itself.
    void closeTask.catch(() => undefined);
  };
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    close();
  }, 30_000);
  signal?.addEventListener("abort", close, { once: true });
  try {
    signal?.throwIfAborted();
    try {
      await client.connect();
    } catch {
      signal?.throwIfAborted();
      throw new DesktopAppPreflightError("initialize");
    }
    try {
      const count = await client.countActiveLoadedThreads();
      signal?.throwIfAborted();
      if (timedOut) throw new DesktopAppPreflightError("activity");
      return count;
    } catch {
      signal?.throwIfAborted();
      throw new DesktopAppPreflightError("activity");
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", close);
    await (closeTask ?? client.close());
  }
}

class DesktopAppPreflightError extends Error {
  constructor(stage) {
    super(stage === "initialize"
      ? "无法完成所选 App Server 的连接初始化；已取消启动"
      : "无法读取所选 App Server 活动 Thread 状态，无法确认当前是否空闲；已取消启动");
  }
}

export async function inspectMacDesktopApp({
  environment = process.env,
  signal,
  candidates = [
    "/Applications/ChatGPT.app",
    join(environment.HOME || homedir(), "Applications", "ChatGPT.app"),
  ],
} = {}) {
  signal?.throwIfAborted();
  for (const path of candidates) {
    signal?.throwIfAborted();
    let bundle;
    try {
      bundle = await lstat(path);
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
      compatible = await fileContainsMarkers(resourcesPath, macCompatibilityMarkers, signal);
    } catch {
      signal?.throwIfAborted();
      return desktopAppFailure(path, "无法读取 ChatGPT Desktop App 资源");
    }
    const version = await readMacBundleVersion(infoPath, signal);
    const running = await macApplicationStatus(path, signal);
    return {
      installed: true,
      path,
      version,
      running,
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

export async function inspectWindowsDesktopApp({
  environment = process.env,
  signal,
  inspectInstallation = () => inspectWindowsDesktopInstallation(environment, signal),
} = {}) {
  signal?.throwIfAborted();
  let installation;
  try {
    installation = await inspectInstallation();
    signal?.throwIfAborted();
  } catch (error) {
    if (error instanceof DesktopCommandCleanupError) throw error;
    signal?.throwIfAborted();
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
  const running = typeof installation.running === "boolean" ? installation.running : null;
  if (!executablePath || !await regularFile(executablePath)) {
    return desktopAppFailure(null, "OpenAI.Codex 包内未找到正式 Desktop 可执行文件", running);
  }
  let compatible;
  try {
    compatible = Boolean(resourcePath)
      && await fileContainsMarkers(resourcePath, [compatibilityMarker], signal);
  } catch {
    signal?.throwIfAborted();
    return desktopAppFailure(executablePath, "无法读取 OpenAI.Codex Desktop 资源", running);
  }
  return {
    installed: true,
    path: executablePath,
    version: stringValue(installation.version) || null,
    running,
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
    signal,
  } = {},
) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(startupConfirmationMs) || startupConfirmationMs < 0 || startupConfirmationMs > desktopCommandTimeoutMs) {
    throw new Error("Desktop 启动确认等待必须为 0 到 15000 毫秒的整数");
  }
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
    let stopping;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      clearTimeout(deadline);
      child.removeListener("error", reject);
      child.removeListener("exit", handleExit);
      child.removeListener("spawn", handleSpawn);
      signal?.removeEventListener("abort", abort);
    };
    const reject = () => {
      if (settled || stopping) return;
      settled = true;
      cleanup();
      rejectLaunch(new Error("OpenAI.Codex Desktop 启动失败"));
    };
    const abort = () => {
      if (settled || stopping) return;
      if (timer) clearTimeout(timer);
      child.removeListener("spawn", handleSpawn);
      stopping = terminateChildProcess(child).then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectLaunch(signal?.aborted ? signal.reason : new Error("OpenAI.Codex Desktop 启动确认超时"));
      }, () => {
        if (settled) return;
        settled = true;
        cleanup();
        child.unref();
        rejectLaunch(new Error("OpenAI.Codex Desktop 启动取消后未能确认子进程退出"));
      });
    };
    const resolve = () => {
      if (settled || stopping) return;
      settled = true;
      cleanup();
      child.unref();
      resolveLaunch();
    };
    const handleExit = () => { if (!stopping) reject(); };
    const handleSpawn = () => {
      if (settled || stopping) return;
      if (startupConfirmationMs === 0) {
        resolve();
        return;
      }
      timer = setTimeout(resolve, startupConfirmationMs);
    };
    const deadline = setTimeout(abort, desktopCommandTimeoutMs + startupConfirmationMs);
    child.once("error", reject);
    child.once("exit", handleExit);
    child.once("spawn", handleSpawn);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function parseDesktopAppArgs(args) {
  if (args.length === 0) return { action: "open" };
  const [action, ...rest] = args;
  if (action === "status" || action === "--provider" || action === "-p") {
    const parsed = { action: action === "status" ? "status" : "open" };
    const flags = action === "status" ? rest : args;
    for (let index = 0; index < flags.length; index += 1) {
      if (flags[index] === "--json" && parsed.action === "status" && parsed.json !== true) {
        parsed.json = true;
      } else if ((flags[index] === "--provider" || flags[index] === "-p") && parsed.provider === undefined) {
        const provider = flags[index + 1];
        if (typeof provider !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(provider)) {
          throw new Error("-p / --provider 必须指定 Provider ID 或已配置的 sf- 名称");
        }
        parsed.provider = provider;
        index += 1;
      } else {
        throw new Error(desktopAppCommandUsage);
      }
    }
    return parsed;
  }
  if (action === "enable") {
    if (rest.length === 0) return { action };
    if (rest.length === 2 && rest[0] === "--port") {
      const port = Number(rest[1]);
      if (/^\d+$/u.test(rest[1]) && Number.isInteger(port) && port >= 1 && port <= 65_535) {
        return { action, port };
      }
    }
  }
  if (action === "disable" && rest.length === 0) {
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
  selectedProvider,
  dataDir,
  inspectSupervisorState,
}) {
  let tokenReady = false;
  let bridgeReady = false;
  let toolHostSupported = false;
  let toolHostAttached = false;
  let providerSelectionSupported = false;
  let desktopAppProvider = null;
  let primaryInstanceState = "unknown";
  let providerInstanceState = "unknown";
  if (supported) {
    try {
      const inspection = await inspectSupervisorState(primarySocketPath);
      if (inspection.status === "ready" && inspection.topology.primaryProvider === primaryProvider) {
        const topology = inspection.topology;
        if (topology.runningProviders.includes(primaryProvider)) primaryInstanceState = "running";
        else if (topology.releasedProviders.includes(primaryProvider)) primaryInstanceState = "released";
        if (topology.runningProviders.includes(selectedProvider)) providerInstanceState = "running";
        else if (topology.releasedProviders.includes(selectedProvider)) providerInstanceState = "released";
        providerSelectionSupported = topology.desktopAppProviderProtocolVersion === 1;
        desktopAppProvider = topology.desktopAppProvider ?? null;
        if (platform === "darwin" && desktopConfig?.enabled === true) {
          toolHostSupported = topology.desktopAppHostProtocolVersion === 2 && providerSelectionSupported;
          toolHostAttached = toolHostSupported && topology.desktopAppAttached === true
            && desktopAppProvider === selectedProvider;
        }
      }
    } catch {
      // 无法读取现有拓扑时保留 unknown，不启动或恢复实例。
    }
  }
  if (platform === "win32" && desktopConfig?.enabled === true && primaryProvider === "openai") {
    try {
      const token = readDesktopAppBridgeToken(dataDir);
      tokenReady = typeof token === "string" && token.length > 0;
      // A bridge handshake acquires a lease and may restore a released instance.
      // Status stays read-only, so connectivity is checked only during launch.
      bridgeReady = null;
    } catch {
      tokenReady = false;
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
    primaryInstanceState,
    provider: selectedProvider,
    providerInstanceState,
    providerSelectionSupported,
    desktopAppProvider,
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
      ? "兼容入口：可用（仅启动入口检查，不代表内置工具可用）"
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
      writeMessage("note", `内置工具 Host：${
        status.toolHostAttached ? "attached（租约已连接，MCP 工具就绪状态未验证）" : "not-attached"
      }`);
    } else {
      writeMessage(status.bridgeReady === null ? "note" : status.bridgeReady ? "success" : "failure", `共享桥：${
        status.bridgeReady === null ? "not-checked（只读状态不建立桥连接）"
          : status.bridgeReady ? "ready" : "not-ready"
      }`);
    }
  }
  writeMessage("note", `本次目标 Provider：${status.provider}（不保存选择）`);
  if (status.supported) {
    const states = { running: "运行中", released: "已释放（下次连接时恢复）", unknown: "未知" };
    writeMessage("note", `目标 App Server 实例：${states[status.providerInstanceState]}`);
    if (status.desktopAppProvider !== null) {
      writeMessage("note", `当前 Desktop Host Provider：${status.desktopAppProvider}`);
    }
  }
}

function writeDesktopAppConfig(configPath, next) {
  const document = readGatewayConfig(configPath);
  validateGatewayConfigDocument(document);
  const codex = table(document.codex);
  const previous = codex.desktop_app;
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
  phase,
}) {
  let rollbackError;
  let rollbackPhase = "读取并校验当前配置";
  try {
    const document = readGatewayConfig(configPath);
    const validated = validateGatewayConfigDocument(document);
    const codex = table(document.codex);
    const current = desktopAppConfig(validated.codex.desktop_app);
    if (JSON.stringify(current) !== JSON.stringify(applied)) {
      rollbackPhase = "配置已被其他操作修改，拒绝覆盖";
      throw new Error("config.toml 在 Desktop App 配置回滚前已发生变化");
    }
    rollbackPhase = "保存原共享配置";
    if (previous === undefined) delete codex.desktop_app;
    else codex.desktop_app = previous;
    document.codex = codex;
    validateGatewayConfigDocument(document);
    writeGatewayConfig(configPath, document);
    rollbackPhase = "原共享配置已恢复，重启 App Server";
    await restartAppServer();
  } catch (error) {
    rollbackError = error;
  }
  if (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      `Codex Desktop App 配置失败，且回滚未完全完成。\n原操作：${phase}${desktopFailureCode(cause)}。\n恢复失败：${rollbackPhase}${desktopFailureCode(rollbackError)}。\n请先运行 codexc app status 检查共享配置，再检查 codexc status appserver 与 codexc logs appserver；确认配置后再重启。`,
      { cause: rollbackError },
    );
  }
  throw cause;
}

// Display bounded classifications, never raw config parsing or bridge errors:
// those can contain private configuration lines or authenticated endpoints.
function desktopFailureCode(error) {
  if (Number.isSafeInteger(error?.exitCode)) return `（退出码 ${error.exitCode}）`;
  if (["EACCES", "EPERM", "ENOENT", "ENOSPC", "EBUSY", "ETIMEDOUT", "ECONNREFUSED"].includes(error?.code)) {
    return `（${error.code}）`;
  }
  return "";
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

function desktopAppFailure(path, reason, running = null) {
  return {
    installed: true,
    path,
    version: null,
    running,
    compatible: false,
    reason,
  };
}

function inspectDesktopAppForPlatform(platform, environment, signal) {
  if (platform === "darwin") return inspectMacDesktopApp({ environment, signal });
  if (platform === "win32") return inspectWindowsDesktopApp({ environment, signal });
  return unsupportedDesktopApp();
}

class DesktopCommandCleanupError extends Error {
  constructor(cause) {
    super("Desktop 平台命令终止未获确认，请检查残留进程", { cause });
    this.name = "DesktopCommandCleanupError";
  }
}

async function runDesktopPlatformCommand(file, args, { signal, ...options } = {}) {
  signal?.throwIfAborted();
  const invocation = supervisedCliInvocation({ file, args });
  const child = spawn(invocation.file, invocation.args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (process.platform !== "win32") registerChildProcessGroup(child);
  let failure;
  let stdout = "";
  let capturedBytes = 0;
  let stopping;
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const stop = (cause) => {
    failure ??= cause;
    stopping ??= (async () => {
      if (!childProcessIsRunning(child)) {
        // A closed leader cannot safely identify its former process group.
        // Open output pipes still prevent us from confirming child cleanup.
        throw new Error("Desktop 平台命令主进程已退出，输出通道仍未关闭");
      }
      await terminateChildProcess(child);
    })().catch(error => {
      failure = new DesktopCommandCleanupError(new AggregateError([failure, error]));
      child.unref();
    }).finally(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolveStopped();
    });
  };
  const abort = () => stop(signal.reason);
  const collect = (chunk, retain) => {
    capturedBytes += Buffer.byteLength(chunk);
    if (capturedBytes > maximumDesktopCommandOutputBytes) {
      stop(new Error("Desktop 平台命令输出超过 1 MiB"));
    } else if (retain) {
      stdout += chunk;
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => collect(chunk, true));
  child.stderr.on("data", chunk => collect(chunk, false));
  const closed = new Promise(resolveClose => {
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const timeout = setTimeout(() => stop(Object.assign(
    new Error("Desktop 平台命令等待超时"), { code: "ETIMEDOUT" },
  )), desktopCommandTimeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await Promise.race([closed, stopped]);
    await stopping;
    if (failure) throw failure;
    if (!result || result.code !== 0 || result.signal) {
      throw new Error("Desktop 平台命令执行失败");
    }
    return { stdout };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function inspectWindowsDesktopInstallation(environment, signal) {
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
  let result;
  try {
    result = await runDesktopPlatformCommand(invocation.file, invocation.args, {
      env: environment,
      signal,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    if (error instanceof DesktopCommandCleanupError) throw error;
    signal?.throwIfAborted();
    throw new Error("Windows Desktop 安装包查询失败", { cause: error });
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Windows Desktop 安装包查询返回无效");
  }
}

async function readMacBundleVersion(infoPath, signal) {
  try {
    const result = await runDesktopPlatformCommand(
      "/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPath],
      { signal },
    );
    return result.stdout.trim() || null;
  } catch (error) {
    if (error instanceof DesktopCommandCleanupError) throw error;
    signal?.throwIfAborted();
    return null;
  }
}

async function macApplicationStatus(appPath, signal) {
  try {
    const result = await runDesktopPlatformCommand("/usr/bin/osascript", [
      "-e",
      "on run argv",
      "-e",
      "application (item 1 of argv) is running",
      "-e",
      "end run",
      appPath,
    ], { signal });
    const status = result.stdout.trim();
    if (status === "true") return true;
    if (status === "false") return false;
    return null;
  } catch (error) {
    if (error instanceof DesktopCommandCleanupError) throw error;
    signal?.throwIfAborted();
    return null;
  }
}

async function openMacDesktopApp(path, _endpoint, provider, { signal } = {}) {
  const resourcesPath = join(path, "Contents", "Resources");
  const nodePath = join(resourcesPath, "cua_node", "bin", "node");
  try {
    await runDesktopPlatformCommand("/usr/bin/open", [
      "--env",
      "CODEX_APP_SERVER_FORCE_CLI=1",
      "--env",
      `CODEX_CONNECT_DESKTOP_PROVIDER=${provider}`,
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
    ], { signal });
  } catch (error) {
    if (error instanceof DesktopCommandCleanupError) throw error;
    signal?.throwIfAborted();
    throw new Error("ChatGPT Desktop App 启动失败", { cause: error });
  }
}

async function fileContainsMarkers(path, markers, signal) {
  signal?.throwIfAborted();
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) return false;
  const descriptor = await open(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  const remaining = new Set(markers);
  const carryLength = Math.max(...markers.map(marker => marker.length)) - 1;
  try {
    const openedStatus = await descriptor.stat();
    if (!openedStatus.isFile()) return false;
    let position = 0;
    while (position < openedStatus.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await descriptor.read(chunk, 0, Math.min(chunk.length, openedStatus.size - position), position);
      if (bytesRead === 0) return false;
      position += bytesRead;
      const current = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      for (const marker of remaining) {
        if (current.includes(marker)) remaining.delete(marker);
      }
      if (remaining.size === 0) return true;
      carry = current.subarray(Math.max(0, current.length - carryLength));
    }
    return false;
  } finally {
    await descriptor.close();
  }
}

async function regularFile(path) {
  try {
    const status = await lstat(path);
    return status.isFile() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}

// The caller already holds a ready Provider lease. This is a separate bridge
// readiness budget, not the Supervisor's 60s instance-startup lease budget.
function probeDesktopAppBridge(endpoint, { signal, timeoutMs = 30_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(endpoint, {
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
    });
    let settled = false;
    let closing = false;
    let ready = false;
    let closeTimeout;
    const complete = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(closeTimeout);
      signal?.removeEventListener("abort", abort);
      socket.removeAllListeners();
      socket.once("error", () => undefined);
      if (signal?.aborted) rejectPromise(signal.reason);
      else resolvePromise(ready);
    };
    const finish = (value) => {
      if (settled || closing) return;
      closing = true;
      ready = value;
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.CLOSED) {
        complete();
        return;
      }
      closeTimeout = setTimeout(() => {
        socket.terminate();
        complete();
      }, 2_000);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
    };
    const abort = () => {
      if (closing) socket.terminate();
      else finish(false);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => {
      if (!closing) ready = false;
      complete();
    });
    socket.once("unexpected-response", (_request, response) => {
      response.destroy();
      finish(false);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function privateBridgeEndpoint(port, token, provider) {
  const target = provider === undefined ? "" : `&provider=${encodeURIComponent(provider)}`;
  return `ws://127.0.0.1:${port}${bridgePath}?token=${encodeURIComponent(token)}${target}`;
}

function resolveDesktopAppSocketPath(appServer, provider) {
  if (provider === appServer.primaryProvider) return appServer.primarySocketPath;
  const index = appServer.managedProviders.findIndex((entry) => entry.provider === provider);
  const socketPath = index < 0 ? undefined : appServer.socketPaths[index + 1];
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    if (provider === aggregateProviderId) {
      throw new Error("聚合模式暂时关闭，请选择独立 Provider；已有聚合会话和数据保留");
    }
    throw new Error("Desktop Provider 未配置；请使用完整、已配置的 Provider ID");
  }
  return socketPath;
}

function table(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
