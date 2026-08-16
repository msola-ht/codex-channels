import { isAbsolute, join, resolve } from "node:path";

import {
  loadManagedProviderAppServers,
  loadPrimaryModelProvider,
  providerAppServerSocketPath,
} from "./model-provider-runtime.mjs";

export function resolvePrimaryAppServerSocketPath(document, dataDir) {
  const codex = table(document?.codex);
  const configured = stringValue(codex.socket_path);
  const candidate = configured || join(dataDir, "runtime", "codex-app-server.sock");
  return isAbsolute(candidate) ? resolve(candidate) : resolve(dataDir, candidate);
}

export function resolveAppServerRuntime(document, dataDir, environment = process.env) {
  const primarySocketPath = resolvePrimaryAppServerSocketPath(document, dataDir);
  const managedProviders = loadManagedProviderAppServers(environment);
  const managedSocketPaths = managedProviders.map(({ provider }) =>
    providerAppServerSocketPath(primarySocketPath, provider));
  const primaryProvider = loadPrimaryModelProvider(environment);
  const socketPaths = [
    primarySocketPath,
    ...managedSocketPaths,
  ];
  return {
    primarySocketPath,
    primaryProvider,
    managedProviders,
    managedSocketPaths,
    socketPaths,
    topology: {
      primaryProvider,
      managedProviders: managedProviders.map(({ provider }) => provider),
      socketPaths,
    },
  };
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
