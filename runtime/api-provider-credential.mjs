import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import {
  assertPrivateDirectoryAccessSync,
  securePrivateDirectorySync,
  writePrivateFileAtomicSync,
} from "./private-file.mjs";
import {
  readWindowsSecureRecordSync,
  removeWindowsSecureRecordSync,
  windowsSecureRecordPath,
  writeWindowsSecureRecordSync,
} from "./windows-secure-record.mjs";

const maximumApiKeyBytes = 16_384;
const providerIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function apiProviderCredentialPath(credentialsDirectory, providerId) {
  const directory = join(
    credentialsDirectory,
    "api-providers",
    validProviderId(providerId),
  );
  return process.platform === "win32"
    ? windowsSecureRecordPath(directory, "api-key")
    : join(directory, "api-key");
}

export function readApiProviderKey(credentialsDirectory, providerId) {
  const root = join(credentialsDirectory, "api-providers");
  const directory = join(root, validProviderId(providerId));
  if (process.platform === "win32") {
    const value = readWindowsSecureRecordSync(directory, "api-key", process.env);
    if (value === null) {
      const error = new Error("第三方 API Key 凭据不存在");
      error.code = "ENOENT";
      throw error;
    }
    return validateApiKey(value);
  }
  assertPrivateDirectory(credentialsDirectory);
  assertPrivateDirectory(root);
  assertPrivateDirectory(directory);
  const path = join(directory, "api-key");
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new Error("第三方 API Key 凭据文件权限无效");
  }
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && status.uid !== currentUserId) {
    throw new Error("第三方 API Key 凭据文件所有者无效");
  }
  if (status.size <= 0 || status.size > maximumApiKeyBytes) {
    throw new Error("第三方 API Key 凭据文件大小无效");
  }
  return validateApiKey(readFileSync(path, "utf8"));
}

export function writeApiProviderKey(credentialsDirectory, providerId, apiKey) {
  const id = validProviderId(providerId);
  const value = validateApiKey(apiKey);
  const root = join(credentialsDirectory, "api-providers");
  const directory = join(root, id);
  const path = join(directory, "api-key");
  ensurePrivateDirectory(credentialsDirectory);
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(directory);
  if (process.platform === "win32") {
    writeWindowsSecureRecordSync(directory, "api-key", value, process.env);
    return;
  }
  writePrivateFileAtomicSync(path, `${value}\n`);
}

export function removeApiProviderKey(credentialsDirectory, providerId) {
  const id = validProviderId(providerId);
  if (!existsSync(credentialsDirectory)) return;
  assertPrivateDirectory(credentialsDirectory);
  const root = join(credentialsDirectory, "api-providers");
  if (!existsSync(root)) return;
  assertPrivateDirectory(root);
  const directory = join(root, id);
  if (!existsSync(directory)) return;
  assertPrivateDirectory(directory);
  if (process.platform === "win32") {
    removeWindowsSecureRecordSync(directory, "api-key");
    return;
  }
  rmSync(join(directory, "api-key"), { force: true });
  rmdirSync(directory);
  try {
    rmdirSync(root);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY") throw error;
  }
}

function validProviderId(value) {
  if (typeof value !== "string" || !providerIdPattern.test(value)) {
    throw new Error("第三方 API 提供商 ID 无效");
  }
  return value;
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  if (process.platform === "win32") {
    securePrivateDirectorySync(path);
  } else {
    assertPrivateDirectory(path);
    chmodSync(path, 0o700);
  }
  assertPrivateDirectory(path);
}

function assertPrivateDirectory(path) {
  const status = lstatSync(path);
  const currentUserId = process.getuid?.();
  if (
    !status.isDirectory()
    || status.isSymbolicLink()
    || (currentUserId !== undefined && status.uid !== currentUserId)
    || (process.platform !== "win32" && (status.mode & 0o077) !== 0)
  ) {
    throw new Error("第三方 API Key 凭据目录权限无效");
  }
  if (process.platform === "win32") assertPrivateDirectoryAccessSync(path);
}

function validateApiKey(value) {
  if (typeof value !== "string") throw new Error("第三方 API Key 无效");
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || Buffer.byteLength(trimmed, "utf8") > maximumApiKeyBytes
    || [...trimmed].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    throw new Error("第三方 API Key 无效");
  }
  return trimmed;
}
