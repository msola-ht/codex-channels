import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";

export const packageDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

export function userDataDir(environment = process.env) {
  const configured = environment.CODEX_CONNECT_HOME?.trim();
  return resolve(configured || join(homedir(), ".codex-connect"));
}

export function runtimeConfig(environment = process.env) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = explicitConfigFile
    ? resolve(explicitConfigFile)
    : environment.CODEX_CONNECT_HOME
      ? join(userDataDir(environment), "config.toml")
      : join(packageDir, "config.toml");
  return {
    configPath,
    dataDir: dirname(configPath),
  };
}

export function initializeUserData({ environment = process.env, cwd = process.cwd() } = {}) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = explicitConfigFile
    ? resolve(explicitConfigFile)
    : join(userDataDir(environment), "config.toml");
  const dataDir = dirname(configPath);
  const resolvedCwd = realpathSync(resolve(cwd));
  if (existsSync(configPath)) {
    if (!explicitConfigFile) {
      chmodSync(dataDir, 0o700);
    }
    chmodSync(configPath, 0o600);
    return { created: false, configPath, dataDir, workspace: resolvedCwd };
  }

  const runtimeDir = join(dataDir, "runtime");
  const stateDir = join(dataDir, "data");
  const workspaceDir = join(dataDir, "workspace");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  if (!explicitConfigFile) {
    chmodSync(dataDir, 0o700);
  }
  chmodSync(runtimeDir, 0o700);
  chmodSync(stateDir, 0o700);
  chmodSync(workspaceDir, 0o700);

  const defaultCwd = realpathSync(workspaceDir);
  const defaultWorkspace = { id: "codex-connect", name: ".codex-connect/workspace", cwd: defaultCwd };
  writeGatewayConfig(configPath, {
    version: 1,
    default_workspace: defaultWorkspace.id,
    telegram: {
      bot_token: "",
      allowed_user_ids: [],
      message_format: "html",
    },
    network: {
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      no_proxy: "localhost,127.0.0.1",
    },
    codex: {
      binary: "codex",
      socket_path: "runtime/codex-app-server.sock",
      default_model: "",
      sandbox: "workspace-write",
    },
    approval: { timeout_seconds: 300 },
    storage: { database_path: "data/gateway.sqlite3" },
    logging: { level: "info" },
    workspaces: [defaultWorkspace],
  });
  return { created: true, configPath, dataDir, workspace: defaultCwd };
}

export function requireUserConfig(environment = process.env) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const home = userDataDir(environment);
  const configPath = explicitConfigFile ? resolve(explicitConfigFile) : join(home, "config.toml");
  const dataDir = explicitConfigFile ? dirname(configPath) : home;
  if (!existsSync(configPath)) {
    throw new Error(`尚未初始化，请先运行 codexc init\n配置目录：${dataDir}`);
  }
  if (!explicitConfigFile) {
    chmodSync(dataDir, 0o700);
  }
  chmodSync(configPath, 0o600);
  return { configPath, dataDir };
}

export function resolveConfiguredPath(value, baseDirectory, fallback) {
  const candidate = value?.trim() || fallback;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(baseDirectory, candidate);
}
