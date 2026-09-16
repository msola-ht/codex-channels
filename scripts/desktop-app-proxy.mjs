#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { acquireMacDesktopAppHostLease } from "../runtime/app-server-supervisor.mjs";
import { parseMacDesktopAppToolsEnabled } from "../runtime/desktop-app-host.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  childProcessIsRunning,
  installProcessSignalHandlers,
  terminateChildProcess,
} from "../runtime/process-lifecycle.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

try {
  await runDesktopAppProxy();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function runDesktopAppProxy() {
  const desktopArguments = process.argv.slice(2);
  if (process.platform !== "darwin" || !desktopArguments.includes("app-server")) {
    throw new Error("Codex Desktop App 受管入口只接受 macOS App Server 连接");
  }
  const toolsEnabled = parseMacDesktopAppToolsEnabled(desktopArguments);
  const pipePath = requiredEnvironmentValue("CODEX_APP_TOOLS_PIPE_PATH");
  const resourcesPath = resolve(requiredEnvironmentValue("CODEX_ELECTRON_RESOURCES_PATH"));
  const appPath = dirname(dirname(resourcesPath));
  const located = requireUserConfig(process.env);
  const document = readGatewayConfig(located.configPath);
  const codex = table(document.codex);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: located.dataDir,
    CODEX_CONNECT_CONFIG_FILE: located.configPath,
    CODEX_BINARY: stringValue(codex.binary) || "codex",
  };
  const appServer = resolveAppServerRuntime(document, located.dataDir, environment);
  if (codex.desktop_app?.enabled !== true || appServer.primaryProvider !== "openai") {
    throw new Error("Codex Desktop App 共享未启用或主 Provider 不是 OpenAI");
  }

  const lease = await acquireMacDesktopAppHostLease(appServer.primarySocketPath, {
    provider: appServer.primaryProvider,
    pipePath,
    appPath,
    toolsEnabled,
  });
  let child;
  let cleanupSignals = () => undefined;
  try {
    const invocation = resolveExecutableInvocation(environment.CODEX_BINARY, [
      "app-server",
      "proxy",
      "--sock",
      appServer.primarySocketPath,
    ], environment);
    child = spawn(invocation.file, invocation.args, {
      env: environment,
      stdio: "inherit",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    cleanupSignals = installProcessSignalHandlers({
      SIGINT: () => childProcessIsRunning(child) && child.kill("SIGINT"),
      SIGTERM: () => childProcessIsRunning(child) && child.kill("SIGTERM"),
      SIGHUP: () => childProcessIsRunning(child) && child.kill("SIGHUP"),
    });
    const result = await new Promise((resolveResult, rejectResult) => {
      child.once("error", rejectResult);
      child.once("exit", (code, signal) => resolveResult({ code, signal }));
    });
    if (result.signal) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = result.code ?? 1;
  } finally {
    cleanupSignals();
    if (childProcessIsRunning(child)) await terminateChildProcess(child);
    await lease.close();
  }
}

function requiredEnvironmentValue(name) {
  const value = process.env[name]?.trim();
  if (!value || value.includes("\0")) {
    throw new Error(`Codex Desktop App 未提供 ${name}`);
  }
  return value;
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
