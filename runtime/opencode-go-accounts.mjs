import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { providerStorageRoot } from "./connect-home.mjs";
import { writePrivateFileAtomicSync } from "./private-file.mjs";

const accountIdPattern = /^[a-z0-9_-]{1,32}$/u;
const reservedAccountIds = new Set(["openai", "deepseek"]);
const maximumRegistryBytes = 262_144;
export const opencodeGoDefaultAccountId = "opencode-go";
const opencodeGoProviderPrefix = "opencode-go-";
const defaultAccountId = opencodeGoDefaultAccountId;

export function isOpencodeGoProvider(provider) {
  if (typeof provider !== "string") return false;
  if (provider === defaultAccountId) return true;
  if (!provider.startsWith(opencodeGoProviderPrefix)) return false;
  try {
    validateOpencodeGoAccountId(provider.slice(opencodeGoProviderPrefix.length));
    return true;
  } catch {
    return false;
  }
}

export function sharedProviderProxyKey(provider) {
  return isOpencodeGoProvider(provider) ? "opencode-go" : provider;
}

export function opencodeGoAccountIdFromProvider(provider) {
  if (!isOpencodeGoProvider(provider)) return undefined;
  if (provider === defaultAccountId) return defaultAccountId;
  const accountId = provider.slice(opencodeGoProviderPrefix.length);
  return accountId.length === 0 ? undefined : accountId;
}

export function opencodeGoProviderId(accountId) {
  validateOpencodeGoAccountId(accountId);
  if (accountId === defaultAccountId) return defaultAccountId;
  return `${opencodeGoProviderPrefix}${accountId}`;
}

export function validateOpencodeGoAccountId(accountId) {
  if (
    typeof accountId !== "string"
    || !accountIdPattern.test(accountId)
    || reservedAccountIds.has(accountId)
  ) {
    throw new Error(
      "OpenCode Go 账户 id 必须是小写字母/数字/`-`/`_` 组成的 1-32 位字符串，且不能与现有 Provider id 冲突；默认账户使用 opencode-go",
    );
  }
  return accountId;
}

export function opencodeGoAccountsDirectory(environment = process.env) {
  return join(providerStorageRoot(environment), "opencode-go", "accounts");
}

export function opencodeGoAccountsFilePath(environment = process.env) {
  return join(providerStorageRoot(environment), "opencode-go", "accounts.json");
}

export function opencodeGoAccountDirectory(environment, accountId) {
  validateOpencodeGoAccountId(accountId);
  return join(opencodeGoAccountsDirectory(environment), accountId);
}

export function opencodeGoAccountMarkerPath(environment, accountId) {
  return join(opencodeGoAccountDirectory(environment, accountId), "managed.toml");
}

export function opencodeGoAccountBackupDirectory(environment, accountId) {
  return join(opencodeGoAccountDirectory(environment, accountId), "backup");
}

export function loadOpencodeGoAccounts(environment = process.env) {
  const path = opencodeGoAccountsFilePath(environment);
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readRegistryFile(path));
  } catch {
    throw new Error("OpenCode Go 账户注册表无法安全读取");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("OpenCode Go 账户注册表无效");
  }
  const accounts = [];
  const seen = new Set();
  let defaultCount = 0;
  for (const entry of parsed) {
    const record = table(entry);
    const id = record.id;
    if (typeof id !== "string" || seen.has(id)) {
      throw new Error("OpenCode Go 账户注册表包含重复或无效账户");
    }
    validateOpencodeGoAccountId(id);
    const isDefault = record.default === true;
    if (isDefault) defaultCount += 1;
    seen.add(id);
    accounts.push({ id, default: isDefault });
  }
  if (defaultCount > 1) {
    throw new Error("OpenCode Go 账户注册表包含多个默认账户");
  }
  return accounts;
}

export function writeOpencodeGoAccounts(environment, accounts) {
  const normalized = accounts.map((account) => {
    validateOpencodeGoAccountId(account.id);
    return { id: account.id, default: account.default === true };
  });
  if (
    normalized.length === 0
    || normalized.some((account, index) =>
      normalized.findIndex((candidate) => candidate.id === account.id) !== index)
  ) {
    throw new Error("OpenCode Go 账户注册表无效");
  }
  if (normalized.filter((account) => account.default).length > 1) {
    throw new Error("OpenCode Go 账户注册表只能有一个默认账户");
  }
  writePrivateFileAtomicSync(
    opencodeGoAccountsFilePath(environment),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  return normalized;
}

export function loadOpencodeGoDefaultAccount(environment = process.env) {
  const accounts = loadOpencodeGoAccounts(environment);
  if (accounts.length === 0) return undefined;
  return accounts.find((account) => account.default) ?? accounts[0];
}

export function readOpencodeGoAccountMarker(environment, accountId) {
  const path = opencodeGoAccountMarkerPath(environment, accountId);
  if (!existsSync(path)) return undefined;
  let marker;
  try {
    marker = parse(readPrivateFile(path));
  } catch {
    throw new Error("OpenCode Go 账户管理标记无法安全读取");
  }
  if (
    marker.version !== 1
    || marker.provider !== opencodeGoProviderId(accountId)
    || !["switching", "exclusive"].includes(marker.mode)
  ) {
    throw new Error("OpenCode Go 账户管理标记无效");
  }
  return { version: 1, provider: marker.provider, mode: marker.mode };
}

export function writeOpencodeGoAccountMarker(environment, accountId, mode) {
  if (!["switching", "exclusive"].includes(mode)) {
    throw new Error("OpenCode Go 账户管理模式无效");
  }
  const directory = opencodeGoAccountDirectory(environment, accountId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(
    opencodeGoAccountMarkerPath(environment, accountId),
    stringify({
      version: 1,
      provider: opencodeGoProviderId(accountId),
      mode,
    }),
  );
}

export function migrateLegacyOpencodeGoAccount(environment = process.env) {
  if (existsSync(opencodeGoAccountsFilePath(environment))) {
    return migratePrMainDefaultAccount(environment);
  }
  const providerDirectory = join(providerStorageRoot(environment), "opencode-go");
  const legacyMarkerPath = join(providerDirectory, "managed.toml");
  if (!existsSync(legacyMarkerPath)) {
    return { changed: false, accountId: defaultAccountId };
  }
  const legacyMarker = parse(readPrivateFile(legacyMarkerPath));
  if (
    legacyMarker.version !== 1
    || legacyMarker.provider !== "opencode-go"
    || !["switching", "exclusive"].includes(legacyMarker.mode)
  ) {
    throw new Error("旧版 OpenCode Go 管理标记无效，拒绝迁移");
  }
  // 迁移前校验旧版 Profile/基础配置仍然存在且可安全读取，保持迁移时失败关闭。
  const codexHome = codexHomePath(environment);
  if (legacyMarker.mode === "switching") {
    readPrivateFile(join(codexHome, "sf-opencode-go.config.toml"));
  } else {
    readPrivateFile(join(codexHome, "config.toml"));
  }
  const accountId = defaultAccountId;
  const accountDirectory = opencodeGoAccountDirectory(environment, accountId);
  const backupDirectory = opencodeGoAccountBackupDirectory(environment, accountId);
  const accountMarkerPath = opencodeGoAccountMarkerPath(environment, accountId);
  const touched = [
    opencodeGoAccountsFilePath(environment),
    accountMarkerPath,
    legacyMarkerPath,
  ];
  const snapshots = snapshotFiles(touched);
  const accountDirectoryExisted = existsSync(accountDirectory);
  let accountDirectoryCreated = false;
  try {
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    accountDirectoryCreated = true;
    backupOptional(legacyMarkerPath, join(backupDirectory, "managed.toml"));
    writeOpencodeGoAccounts(environment, [{ id: accountId, default: true }]);
    writeOpencodeGoAccountMarker(environment, accountId, legacyMarker.mode);
    unlinkSync(legacyMarkerPath);
    return { changed: true, accountId };
  } catch (error) {
    restoreSnapshots(snapshots);
    if (accountDirectoryCreated && !accountDirectoryExisted) {
      rmSync(accountDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

// PR #64 shipped `main` as the default account. Keep it for historical
// Threads while creating the stable `opencode-go` default account.
function migratePrMainDefaultAccount(environment) {
  const accounts = loadOpencodeGoAccounts(environment);
  const legacyMain = accounts.find((account) => account.id === "main" && account.default);
  if (!legacyMain || accounts.some((account) => account.id === defaultAccountId)) {
    return { changed: false, accountId: defaultAccountId };
  }
  const mainMarker = readOpencodeGoAccountMarker(environment, "main");
  if (mainMarker?.mode !== "switching") {
    return { changed: false, accountId: "main" };
  }
  const codexHome = codexHomePath(environment);
  const legacyProfilePath = join(codexHome, "sf-opencode-go-main.config.toml");
  const profilePath = join(codexHome, "sf-opencode-go.config.toml");
  if (existsSync(profilePath)) {
    throw new Error("OpenCode Go 默认 Profile 已存在，拒绝自动迁移旧 main 账户");
  }
  const rolePath = join(codexHome, "sf-agent.config.toml");
  const accountDirectory = opencodeGoAccountDirectory(environment, defaultAccountId);
  const markerPath = opencodeGoAccountMarkerPath(environment, defaultAccountId);
  const snapshots = snapshotFiles([
    opencodeGoAccountsFilePath(environment),
    profilePath,
    markerPath,
    rolePath,
  ]);
  const directoryExisted = existsSync(accountDirectory);
  try {
    const migratedProfile = rewriteProviderReferences(
      readPrivateFile(legacyProfilePath),
      "opencode-go-main",
      defaultAccountId,
    );
    const nextAccounts = [
      { id: defaultAccountId, default: true },
      ...accounts.map((account) => ({ ...account, default: false })),
    ];
    writePrivateFileAtomicSync(profilePath, migratedProfile);
    writeOpencodeGoAccountMarker(environment, defaultAccountId, "switching");
    if (existsSync(rolePath)) {
      const rewrittenRole = rewriteRoleReferences(
        readPrivateFile(rolePath),
        "opencode-go-main",
        defaultAccountId,
      );
      if (rewrittenRole !== undefined) {
        writePrivateFileAtomicSync(
          rolePath,
          rewrittenRole,
        );
      }
    }
    writeOpencodeGoAccounts(environment, nextAccounts);
    return { changed: true, accountId: defaultAccountId };
  } catch (error) {
    restoreSnapshots(snapshots);
    if (!directoryExisted) {
      rmSync(accountDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

function rewriteProviderReferences(content, sourceProvider, targetAccountId) {
  let document;
  try {
    document = parse(content);
  } catch {
    throw new Error("OpenCode Go 旧 Profile 无法安全解析，拒绝迁移");
  }
  if (document.model_provider !== sourceProvider) {
    throw new Error("OpenCode Go 旧 Profile 与 Provider 不一致，拒绝迁移");
  }
  const providers = table(document.model_providers);
  const provider = table(providers[sourceProvider]);
  if (Object.keys(provider).length === 0) {
    throw new Error("OpenCode Go 旧 Profile 缺少 Provider 配置，拒绝迁移");
  }
  const targetProvider = opencodeGoProviderId(targetAccountId);
  const nextProviders = { ...providers };
  delete nextProviders[sourceProvider];
  nextProviders[targetProvider] = { ...provider, name: targetProvider };
  return stringify({
    ...document,
    model_provider: targetProvider,
    model_providers: nextProviders,
  });
}

function rewriteRoleReferences(content, sourceProvider, targetAccountId) {
  let document;
  try {
    document = parse(content);
  } catch {
    throw new Error("OpenCode Go 旧版子代理角色文件无法安全解析，拒绝迁移");
  }
  if (document.model_provider !== sourceProvider) return undefined;
  return rewriteProviderReferences(content, sourceProvider, targetAccountId);
}

export function opencodeGoApiKeyEnvironmentKey(accountId) {
  validateOpencodeGoAccountId(accountId);
  if (accountId === defaultAccountId) {
    return "CODEX_CONNECT_OPENCODE_GO_API_KEY";
  }
  return `CODEX_CONNECT_OPENCODE_GO_${sanitizeEnvironmentName(accountId)}_API_KEY`;
}

function sanitizeEnvironmentName(accountId) {
  return accountId.replace(/[^a-zA-Z0-9]/gu, "_").toUpperCase();
}

function readRegistryFile(path) {
  const status = statPrivate(path);
  if (status.size > maximumRegistryBytes) {
    throw new Error("OpenCode Go 账户注册表过大");
  }
  return readFileSync(path, "utf8");
}

function readPrivateFile(path) {
  const status = statPrivate(path);
  if (status.size > 262_144) {
    throw new Error("OpenCode Go 配置文件过大");
  }
  return readFileSync(path, "utf8");
}

function statPrivate(path) {
  const status = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    !status.isFile()
    || status.isSymbolicLink()
    || (status.mode & 0o077) !== 0
    || (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new Error("OpenCode Go 文件权限或类型无效");
  }
  return status;
}

function backupOptional(source, target) {
  if (!existsSync(source)) return false;
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return true;
}

function snapshotFiles(paths) {
  return [...new Set(paths)].map((path) => ({
    path,
    content: existsSync(path) ? readFileSync(path) : undefined,
  }));
}

function restoreSnapshots(snapshots) {
  for (const { path, content } of snapshots) {
    if (content === undefined) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      writePrivateFileAtomicSync(path, content);
    }
  }
}

function table(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
