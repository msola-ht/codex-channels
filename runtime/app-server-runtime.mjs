import { isAbsolute, join, resolve } from "node:path";

import {
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedProviderAppServers,
  loadPrimaryModelProvider,
  providerAppServerSocketPath,
} from "./model-provider-runtime.mjs";

const windowsUnixSocketPathCapacityBytes = 108;

export function resolvePrimaryAppServerSocketPath(document, dataDir) {
  const codex = table(document?.codex);
  const configured = stringValue(codex.socket_path);
  const candidate = configured || join(dataDir, "runtime", "codex-app-server.sock");
  return isAbsolute(candidate) ? resolve(candidate) : resolve(dataDir, candidate);
}

export function resolveAppServerRuntime(document, dataDir, environment = process.env) {
  const primarySocketPath = resolvePrimaryAppServerSocketPath(document, dataDir);
  const managedProviders = loadManagedProviderAppServers(environment);
  const customSwitchingProviders = loadConfiguredCustomSwitchingModelProviders(environment);
  const isolatedProviders = [
    ...managedProviders,
    ...customSwitchingProviders,
  ];
  const managedSocketPaths = isolatedProviders.map(({ provider }) =>
    providerAppServerSocketPath(primarySocketPath, provider));
  for (const socketPath of managedSocketPaths) {
    assertAppServerSocketPathSupported(socketPath);
  }
  const primaryProvider = loadPrimaryModelProvider(environment);
  const socketPaths = [
    primarySocketPath,
    ...managedSocketPaths,
  ];
  return {
    primarySocketPath,
    primaryProvider,
    managedProviders: isolatedProviders,
    customSwitchingProviders,
    managedSocketPaths,
    socketPaths,
    topology: {
      primaryProvider,
      managedProviders: isolatedProviders.map(({ provider }) => provider),
      socketPaths,
    },
  };
}

export function assertAppServerSocketPathSupported(
  socketPath,
  platform = process.platform,
) {
  if (platform !== "win32") return;
  const pathBytes = Buffer.byteLength(socketPath, "utf8");
  if (pathBytes < windowsUnixSocketPathCapacityBytes) return;
  throw new Error(
    `Windows App Server Socket 路径过长：当前 ${pathBytes} UTF-8 字节，必须小于 `
    + `${windowsUnixSocketPathCapacityBytes}；请在 config.toml 中把 codex.socket_path `
    + "设置为更短的路径，并为 Provider 后缀预留空间",
  );
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
