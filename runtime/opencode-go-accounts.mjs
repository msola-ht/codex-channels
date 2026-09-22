import {
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import { providerStorageRoot } from "./connect-home.mjs";
import { assertManagedProviderDefaultAccount } from "./managed-provider-account-registry.mjs";
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

export function loadOpencodeGoAccounts(
  environment = process.env,
  { allowMissingDefault = false } = {},
) {
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
  for (const entry of parsed) {
    const record = table(entry);
    const id = record.id;
    if (typeof id !== "string" || seen.has(id)) {
      throw new Error("OpenCode Go 账户注册表包含重复或无效账户");
    }
    validateOpencodeGoAccountId(id);
    const isDefault = record.default === true;
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
  assertManagedProviderDefaultAccount(accounts, "OpenCode Go", { allowMissingDefault });
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
  assertManagedProviderDefaultAccount(normalized, "OpenCode Go");
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

function table(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
