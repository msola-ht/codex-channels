import { isAbsolute, join, resolve } from "node:path";

import {
  loadManagedProviderAppServer,
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
  const managedProvider = loadManagedProviderAppServer(environment);
  const managedSocketPath = managedProvider
    ? providerAppServerSocketPath(primarySocketPath, managedProvider.provider)
    : undefined;
  const primaryProvider = loadPrimaryModelProvider(environment);
  const socketPaths = [
    primarySocketPath,
    ...(managedSocketPath ? [managedSocketPath] : []),
  ];
  return {
    primarySocketPath,
    primaryProvider,
    managedProvider,
    managedSocketPath,
    socketPaths,
    topology: {
      primaryProvider,
      managedProvider: managedProvider?.provider,
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
