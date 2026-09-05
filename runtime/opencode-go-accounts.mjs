import {
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { providerStorageRoot } from "./connect-home.mjs";
import {
  readPrivateFileSync,
  writePrivateFileAtomicSync,
} from "./private-file.mjs";

const accountIdPattern = /^[a-z0-9_-]{1,32}$/u;
const reservedAccountIds = new Set(["openai", "deepseek", "ocg"]);
const maximumRegistryBytes = 262_144;
const opencodeGoProviderPrefix = "ocg-";

export function isOpencodeGoProviderNamespace(provider) {
  return typeof provider === "string"
    && (provider === "ocg" || provider.startsWith(opencodeGoProviderPrefix));
}

export function isOpencodeGoProvider(provider) {
  if (!isOpencodeGoProviderNamespace(provider)) return false;
  const accountId = provider.slice(opencodeGoProviderPrefix.length);
  if (accountId.length === 0) return false;
  try {
    validateOpencodeGoAccountId(accountId);
    return true;
  } catch {
    return false;
  }
}

export function sharedProviderProxyKey(provider) {
  return isOpencodeGoProvider(provider) ? "ocg" : provider;
}

export function opencodeGoAccountIdFromProvider(provider) {
  if (!isOpencodeGoProvider(provider)) return undefined;
  const accountId = provider.slice(opencodeGoProviderPrefix.length);
  return accountId.length === 0 ? undefined : accountId;
}

export function opencodeGoProviderId(accountId) {
  validateOpencodeGoAccountId(accountId);
  return `${opencodeGoProviderPrefix}${accountId}`;
}

export function validateOpencodeGoEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (
    normalized.length === 0
    || normalized.length > 320
    || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) === false
  ) {
    throw new Error("OpenCode Go 邮箱必须是有效的邮箱地址，最长 320 个字符");
  }
  return normalized;
}

export function validateOpencodeGoPhone(phone) {
  const normalized = typeof phone === "string"
    ? phone.trim().replace(/[()\s-]/gu, "")
    : "";
  if (!/^\+?[0-9]{7,15}$/u.test(normalized)) {
    throw new Error("OpenCode Go 手机号码必须是 7-15 位数字，可带国家码 +");
  }
  return normalized;
}

export function validateOpencodeGoContact(contact) {
  if (typeof contact !== "string" || contact.trim().length === 0) {
    throw new Error("OpenCode Go 账户必须提供邮箱或手机号码");
  }
  const normalized = contact.trim();
  if (normalized.includes("@")) {
    return { type: "email", value: validateOpencodeGoEmail(normalized) };
  }
  return { type: "phone", value: validateOpencodeGoPhone(normalized) };
}

export function opencodeGoAccountDisplayName(account) {
  const contact = account?.email ?? account?.phone;
  return typeof contact === "string" && contact.length > 0
    ? `ocg-${contact}`
    : `ocg-${account?.id ?? "unknown"}`;
}

export function opencodeGoProviderDisplayName(provider, environment = process.env) {
  const accountId = opencodeGoAccountIdFromProvider(provider);
  if (accountId === undefined) return provider;
  const account = loadOpencodeGoAccounts(environment).find(
    (candidate) => candidate.id === accountId,
  );
  return account === undefined ? provider : opencodeGoAccountDisplayName(account);
}

export function loadOpencodeGoProviderIdentities(environment = process.env) {
  return loadOpencodeGoAccounts(environment).flatMap((account) => {
    const contact = account.email ?? account.phone;
    if (contact === undefined) return [];
    return [{
      provider: opencodeGoProviderId(account.id),
      displayName: opencodeGoAccountDisplayName(account),
      ...(account.email === undefined ? {} : { email: account.email }),
      ...(account.phone === undefined ? {} : { phone: account.phone }),
    }];
  });
}

export function validateOpencodeGoAccountId(accountId) {
  if (
    typeof accountId !== "string"
    || !accountIdPattern.test(accountId)
    || reservedAccountIds.has(accountId)
  ) {
    throw new Error(
      "OpenCode Go 账户 id 必须是小写字母/数字/`-`/`_` 组成的 1-32 位字符串，且不能与现有 Provider id 冲突；Provider 使用 ocg-<accountId>",
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
    const email = record.email === undefined ? undefined : validateOpencodeGoEmail(record.email);
    const phone = record.phone === undefined ? undefined : validateOpencodeGoPhone(record.phone);
    if (email !== undefined && phone !== undefined) {
      throw new Error("OpenCode Go 账户注册表中的邮箱和手机号只能二选一");
    }
    accounts.push({
      id,
      default: isDefault,
      ...(email === undefined ? {} : { email }),
      ...(phone === undefined ? {} : { phone }),
    });
  }
  if (defaultCount > 1) {
    throw new Error("OpenCode Go 账户注册表包含多个默认账户");
  }
  assertUniqueOpencodeGoApiKeyEnvironmentKeys(accounts);
  return accounts;
}

export function writeOpencodeGoAccounts(environment, accounts) {
  const normalized = accounts.map((account) => {
    validateOpencodeGoAccountId(account.id);
    const email = account.email === undefined ? undefined : validateOpencodeGoEmail(account.email);
    const phone = account.phone === undefined ? undefined : validateOpencodeGoPhone(account.phone);
    if (email !== undefined && phone !== undefined) {
      throw new Error("OpenCode Go 账户注册表中的邮箱和手机号只能二选一");
    }
    return {
      id: account.id,
      default: account.default === true,
      ...(email === undefined ? {} : { email }),
      ...(phone === undefined ? {} : { phone }),
    };
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
  assertUniqueOpencodeGoApiKeyEnvironmentKeys(normalized);
  writePrivateFileAtomicSync(
    opencodeGoAccountsFilePath(environment),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  return normalized;
}

function assertUniqueOpencodeGoApiKeyEnvironmentKeys(accounts) {
  const owners = new Map();
  for (const account of accounts) {
    const key = opencodeGoApiKeyEnvironmentKey(account.id);
    const previous = owners.get(key);
    if (previous !== undefined && previous !== account.id) {
      throw new Error(
        `OpenCode Go 账户 ${previous} 与 ${account.id} 的 API Key 环境变量名冲突，请更换账户 id`,
      );
    }
    owners.set(key, account.id);
  }
}

export function loadOpencodeGoDefaultAccount(environment = process.env) {
  const accounts = loadOpencodeGoAccounts(environment);
  return accounts.find((account) => account.default);
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
    return migrateRegisteredLegacyOpencodeGoAccounts(environment);
  }
  const providerDirectory = join(providerStorageRoot(environment), "opencode-go");
  const legacyMarkerPath = join(providerDirectory, "managed.toml");
  if (!existsSync(legacyMarkerPath)) {
    return { changed: false, accountId: undefined };
  }
  const legacyMarker = parse(readPrivateFile(legacyMarkerPath));
  if (
    legacyMarker.version !== 1
    || legacyMarker.provider !== "opencode-go"
    || !["switching", "exclusive"].includes(legacyMarker.mode)
  ) {
    throw new Error("旧版 OpenCode Go 管理标记无效，拒绝迁移");
  }
  // 旧单账户布局没有账户 ID。不能把它静默命名为 main 或其他猜测值，
  // 留给用户以明确的 accountId 重新添加。
  return { changed: false, accountId: undefined };
}

function migrateRegisteredLegacyOpencodeGoAccounts(environment) {
  const accounts = loadOpencodeGoAccounts(environment);
  const codexHome = codexHomePath(environment);
  const rolePath = join(codexHome, "sf-agent.config.toml");
  const migrations = [];
  for (const account of accounts) {
    const markerPath = opencodeGoAccountMarkerPath(environment, account.id);
    if (!existsSync(markerPath)) continue;
    let marker;
    try {
      marker = parse(readPrivateFile(markerPath));
    } catch {
      throw new Error("旧版 OpenCode Go 账户管理标记无法安全读取");
    }
    const sourceProvider = marker.provider;
    const targetAccountId = account.id;
    const targetProvider = opencodeGoProviderId(targetAccountId);
    if (!["opencode-go", `opencode-go-${account.id}`, targetProvider].includes(sourceProvider)) {
      continue;
    }
    if (marker.version !== 1 || !["switching", "exclusive"].includes(marker.mode)) {
      throw new Error("旧版 OpenCode Go 账户管理标记无效");
    }
    const sourceProfileCandidates = [
      join(codexHome, `sf-opencode-go-${account.id}.config.toml`),
      ...(account.default ? [join(codexHome, "sf-opencode-go.config.toml")] : []),
    ];
    const existingSourceProfiles = [...new Set(sourceProfileCandidates)]
      .filter((path) => existsSync(path));
    if (sourceProvider === targetProvider && existingSourceProfiles.length === 0) {
      continue;
    }
    if (marker.mode === "switching" && existingSourceProfiles.length !== 1) {
      throw new Error(existingSourceProfiles.length === 0
        ? "OpenCode Go 旧 Profile 不存在，拒绝迁移"
        : "OpenCode Go 旧 Profile 存在多个候选，拒绝自动迁移");
    }
    const targetProfilePath = marker.mode === "exclusive"
      ? join(codexHome, "config.toml")
      : join(codexHome, `sf-ocg-${targetAccountId}.config.toml`);
    const sourceProfilePath = marker.mode === "exclusive"
      ? targetProfilePath
      : existingSourceProfiles[0];
    if (sourceProfilePath !== targetProfilePath && existsSync(targetProfilePath)) {
      throw new Error("OpenCode Go 目标 Profile 已存在，拒绝自动迁移旧账户");
    }
    if (!existsSync(sourceProfilePath)) {
      throw new Error("OpenCode Go 旧 Profile 不存在，拒绝迁移");
    }
    migrations.push({
      account,
      markerPath,
      marker,
      sourceProvider,
      targetAccountId,
      sourceProfilePath,
      targetProfilePath,
    });
  }
  if (migrations.length === 0) return { changed: false, accountId: undefined };
  const nextAccounts = accounts;
  const snapshots = snapshotFiles([
    opencodeGoAccountsFilePath(environment),
    rolePath,
    ...migrations.flatMap(({
      markerPath,
      sourceProfilePath,
      targetAccountId,
      targetProfilePath,
    }) => [
      markerPath,
      opencodeGoAccountMarkerPath(environment, targetAccountId),
      sourceProfilePath,
      targetProfilePath,
    ]),
  ]);
  try {
    for (const migration of migrations) {
      const migratedProfile = rewriteProviderReferences(
        readPrivateFile(migration.sourceProfilePath),
        migration.sourceProvider,
        migration.targetAccountId,
      );
      writePrivateFileAtomicSync(migration.targetProfilePath, migratedProfile);
      writeOpencodeGoAccountMarker(
        environment,
        migration.targetAccountId,
        migration.marker.mode,
      );
      if (migration.sourceProfilePath !== migration.targetProfilePath) {
        unlinkSync(migration.sourceProfilePath);
      }
    }
    if (existsSync(rolePath)) {
      const role = parse(readPrivateFile(rolePath));
      const migration = migrations.find(
        (candidate) => role.model_provider === candidate.sourceProvider,
      );
      if (migration !== undefined) {
        writePrivateFileAtomicSync(
          rolePath,
          rewriteProviderReferences(
            readPrivateFile(rolePath),
            migration.sourceProvider,
            migration.targetAccountId,
          ),
        );
      }
    }
    writeOpencodeGoAccounts(environment, nextAccounts);
    return {
      changed: true,
      accountId: accounts.find((account) => account.default)?.id,
    };
  } catch (error) {
    restoreSnapshots(snapshots);
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

export function opencodeGoApiKeyEnvironmentKey(accountId) {
  validateOpencodeGoAccountId(accountId);
  return `CODEX_CONNECT_OPENCODE_GO_${sanitizeEnvironmentName(accountId)}_API_KEY`;
}

function sanitizeEnvironmentName(accountId) {
  return accountId.replace(/[^a-zA-Z0-9]/gu, "_").toUpperCase();
}

function readRegistryFile(path) {
  return readPrivateFileSync(path, maximumRegistryBytes);
}

function readPrivateFile(path) {
  return readPrivateFileSync(path, 262_144);
}

function snapshotFiles(paths) {
  return [...new Set(paths)].map((path) => ({
    path,
    content: existsSync(path) ? readPrivateFile(path) : undefined,
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
