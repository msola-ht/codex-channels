import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  assertPrivateConfigAccessSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../runtime/private-file.mjs";
import { packageDir } from "./package-path.mjs";

export { packageDir };

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
    prepareExistingUserConfig(configPath, dataDir, !explicitConfigFile);
    return { created: false, configPath, dataDir, workspace: resolvedCwd };
  }

  const runtimeDir = join(dataDir, "runtime");
  const stateDir = join(dataDir, "data");
  const workspaceDir = join(dataDir, "workspace");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  if (!explicitConfigFile) securePrivateDirectorySync(dataDir);
  securePrivateDirectorySync(runtimeDir);
  securePrivateDirectorySync(stateDir);
  securePrivateDirectorySync(workspaceDir);

  const defaultCwd = realpathSync(workspaceDir);
  initializeWorkspaceRepository(defaultCwd, environment);
  const defaultWorkspace = { id: "codex-connect", name: ".codex-connect/workspace", cwd: defaultCwd };
  writeGatewayConfig(configPath, {
    version: 1,
    default_workspace: defaultWorkspace.id,
    telegram: {
      bot_token: "",
      allowed_user_ids: [],
      message_format: "html",
    },
    codex: {
      binary: "codex",
      socket_path: "runtime/codex-app-server.sock",
      default_model: "",
      sandbox: "workspace-write",
    },
    approval: { timeout_seconds: 900 },
    display: {
      operation_updates: "compact",
      plan_updates: true,
      reasoning: false,
    },
    experimental: {
      plugin_api: false,
    },
    scheduled_tasks: {
      enabled: false,
    },
    storage: { database_path: "data/gateway.sqlite3" },
    logging: { level: "info" },
    workspaces: [defaultWorkspace],
  });
  return { created: true, configPath, dataDir, workspace: defaultCwd };
}

function initializeWorkspaceRepository(workspaceDir, environment) {
  const gitDir = join(workspaceDir, ".git");
  if (existsSync(gitDir)) return;

  // Git-specific environment overrides must not redirect initialization to another repository.
  const gitEnvironment = Object.fromEntries(
    Object.entries({ ...process.env, ...environment }).filter(([key]) => !/^GIT_/iu.test(key)),
  );
  mkdirSync(gitDir, { mode: 0o700 });
  const createdGitDirectory = lstatSync(gitDir);
  const result = spawnSync("git", ["init", "--quiet", "--no-bare", "--", workspaceDir], {
    cwd: workspaceDir,
    env: gitEnvironment,
    stdio: "ignore",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    // Roll back only this invocation's directory; preserve a replacement or an existing repository.
    const remainingGitDirectory = lstatSync(gitDir, { throwIfNoEntry: false });
    if (
      remainingGitDirectory?.isDirectory()
      && remainingGitDirectory.dev === createdGitDirectory.dev
      && remainingGitDirectory.ino === createdGitDirectory.ino
    ) {
      rmSync(gitDir, { recursive: true });
    }
  }
  if (result.error?.code === "ENOENT") {
    throw new Error("默认 Workspace 的 Git 仓库初始化失败：Git 不可用，请安装 Git 后重新运行 codexc init");
  }
  if (result.error || result.status !== 0) {
    throw new Error("默认 Workspace 的 Git 仓库初始化失败：git init 失败，请检查目录权限和 Git 配置后重新运行 codexc init");
  }
}

export function requireUserConfig(environment = process.env) {
  const result = locateUserConfig(environment);
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  prepareExistingUserConfig(
    result.configPath,
    result.dataDir,
    !explicitConfigFile,
  );
  return result;
}

function prepareExistingUserConfig(configPath, dataDir, manageDataDirectory) {
  let configStatus;
  let parentStatus;
  try {
    configStatus = lstatSync(configPath);
    parentStatus = lstatSync(dataDir);
  } catch {
    throw new Error("config.toml 不可用，请检查文件路径和权限");
  }
  if (!configStatus.isFile()) {
    throw new Error("config.toml 必须是普通文件且不能是符号链接");
  }
  if (process.platform === "win32") {
    if (manageDataDirectory) securePrivateDirectorySync(dataDir);
    securePrivateFileSync(configPath);
    assertPrivateConfigAccessSync(configPath);
    return;
  }
  const currentUserId = process.getuid?.();
  if (
    currentUserId !== undefined
    && (configStatus.uid !== currentUserId || parentStatus.uid !== currentUserId)
  ) {
    throw new Error("config.toml 及其父目录必须由当前用户拥有");
  }
  if (!parentStatus.isDirectory() || (parentStatus.mode & 0o022) !== 0) {
    throw new Error("config.toml 父目录权限不安全：不能允许组或其他用户写入");
  }
  if (manageDataDirectory) chmodSync(dataDir, 0o700);
  chmodSync(configPath, 0o600);
}

export function locateUserConfig(environment = process.env) {
  const result = locateOptionalUserConfig(environment);
  if (result) {
    return result;
  }
  const dataDir = environment.CODEX_CONNECT_CONFIG_FILE?.trim()
    ? dirname(resolve(environment.CODEX_CONNECT_CONFIG_FILE.trim()))
    : userDataDir(environment);
  throw new Error(`尚未初始化，请先运行 codexc init\n配置目录：${dataDir}`);
}

export function locateOptionalUserConfig(environment = process.env) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const home = userDataDir(environment);
  const configPath = explicitConfigFile ? resolve(explicitConfigFile) : join(home, "config.toml");
  const dataDir = explicitConfigFile ? dirname(configPath) : home;
  try {
    statSync(configPath);
  } catch (error) {
    if (
      !explicitConfigFile
      && error
      && typeof error === "object"
      && error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  return { configPath, dataDir };
}

export function resolveConfiguredPath(value, baseDirectory, fallback) {
  const candidate = value?.trim() || fallback;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(baseDirectory, candidate);
}
