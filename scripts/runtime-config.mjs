import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

export function userDataDir(environment = process.env) {
  const configured = environment.CODEX_CONNECT_HOME?.trim();
  return resolve(configured || join(homedir(), ".codex-connect"));
}

export function runtimeConfig(environment = process.env) {
  const explicitEnvFile = environment.CODEX_CONNECT_ENV_FILE?.trim();
  const envPath = explicitEnvFile
    ? resolve(explicitEnvFile)
    : environment.CODEX_CONNECT_HOME
      ? join(userDataDir(environment), ".env")
      : join(packageDir, ".env");
  return {
    envPath,
    dataDir: dirname(envPath),
  };
}

export function initializeUserData({ environment = process.env, cwd = process.cwd() } = {}) {
  const explicitEnvFile = environment.CODEX_CONNECT_ENV_FILE?.trim();
  const envPath = explicitEnvFile ? resolve(explicitEnvFile) : join(userDataDir(environment), ".env");
  const dataDir = dirname(envPath);
  const resolvedCwd = realpathSync(resolve(cwd));
  if (existsSync(envPath)) {
    chmodSync(dataDir, 0o700);
    chmodSync(envPath, 0o600);
    return { created: false, dataDir, envPath, workspace: resolvedCwd };
  }

  const runtimeDir = join(dataDir, "runtime");
  const stateDir = join(dataDir, "data");
  const workspaceDir = join(dataDir, "workspace");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  chmodSync(runtimeDir, 0o700);
  chmodSync(stateDir, 0o700);
  chmodSync(workspaceDir, 0o700);

  const defaultCwd = realpathSync(workspaceDir);
  const defaultWorkspace = { id: "codex-connect", name: ".codex-connect/workspace", cwd: defaultCwd };
  const serializedWorkspaces = JSON.stringify([defaultWorkspace]).replaceAll("'", "\\u0027");
  const content = [
    "# Codex Connect 用户配置。请填写 Telegram Token 和允许的用户 ID。",
    "TELEGRAM_BOT_TOKEN=",
    "TELEGRAM_ALLOWED_USER_IDS=",
    "TELEGRAM_PROXY_URL=",
    "HTTP_PROXY=",
    "HTTPS_PROXY=",
    "NO_PROXY=localhost,127.0.0.1",
    "",
    "CODEX_BINARY=codex",
    `CODEX_WORKSPACES_JSON='${serializedWorkspaces}'`,
    `CODEX_DEFAULT_WORKSPACE=${defaultWorkspace.id}`,
    `CODEX_SOCKET_PATH=${join(runtimeDir, "codex-app-server.sock")}`,
    "CODEX_MODEL=",
    "CODEX_SANDBOX=workspace-write",
    "APPROVAL_TIMEOUT_SECONDS=300",
    `STATE_DATABASE_PATH=${join(stateDir, "gateway.sqlite3")}`,
    "LOG_LEVEL=info",
    "",
  ].join("\n");
  writeFileSync(envPath, content, { mode: 0o600, flag: "wx" });
  return { created: true, dataDir, envPath, workspace: defaultCwd };
}

export function requireUserConfig(environment = process.env) {
  const explicitEnvFile = environment.CODEX_CONNECT_ENV_FILE?.trim();
  const home = userDataDir(environment);
  const envPath = explicitEnvFile ? resolve(explicitEnvFile) : join(home, ".env");
  const dataDir = explicitEnvFile ? dirname(envPath) : home;
  if (!existsSync(envPath)) {
    throw new Error(`尚未初始化，请先运行 codexc init\n配置目录：${dataDir}`);
  }
  chmodSync(dataDir, 0o700);
  chmodSync(envPath, 0o600);
  return { dataDir, envPath };
}

export function resolveConfiguredPath(value, baseDirectory, fallback) {
  const candidate = value?.trim() || fallback;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(baseDirectory, candidate);
}
