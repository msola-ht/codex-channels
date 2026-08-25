import { isAbsolute, join, resolve } from "node:path";

import {
  loadConfiguredCustomSwitchingModelProviders,
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
  const customSwitchingProviders = loadConfiguredCustomSwitchingModelProviders(environment);
  const isolatedProviders = [
    ...managedProviders,
    ...customSwitchingProviders,
  ];
  const managedSocketPaths = isolatedProviders.map(({ provider }) =>
    providerAppServerSocketPath(primarySocketPath, provider));
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

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
