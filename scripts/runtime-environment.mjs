import { dirname, join, resolve } from "node:path";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { resolveProxyEnvironment } from "../runtime/network-proxy.mjs";
import { migrateLegacyOpencodeGoAccount } from "../runtime/opencode-go-accounts.mjs";
import { requireUserConfig, userDataDir } from "./runtime-config.mjs";

export function configuredEnvironment(sourceEnvironment = process.env) {
  const { configPath, dataDir } = requireUserConfig(sourceEnvironment);
  const environment = {
    ...sourceEnvironment,
    CODEX_CONNECT_HOME: dataDir,
    CODEX_CONNECT_CONFIG_FILE: configPath,
  };
  migrateLegacyOpencodeGoAccount(environment);
  const document = readGatewayConfig(configPath);
  const network = table(document.network);
  const codex = table(document.codex);
  const proxyEnvironment = resolveProxyEnvironment(network, environment);
  const unresolvedProxyEnvironment = {
    ...environment,
    CODEX_BINARY: stringValue(codex.binary) || "codex",
  };
  return {
    configPath,
    dataDir,
    document,
    unresolvedProxyEnvironment,
    environment: {
      ...unresolvedProxyEnvironment,
      ...proxyEnvironment,
    },
  };
}

export function serviceControlEnvironment(environment = process.env) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = explicitConfigFile
    ? resolve(explicitConfigFile)
    : join(userDataDir(environment), "config.toml");
  return {
    ...environment,
    CODEX_CONNECT_HOME: dirname(configPath),
    CODEX_CONNECT_CONFIG_FILE: configPath,
  };
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
