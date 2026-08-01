import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const maximumApiKeyBytes = 16_384;

export function visionCredentialPath(credentialsDirectory) {
  return join(credentialsDirectory, "vision", "api-key");
}

export function readVisionApiKey(credentialsDirectory) {
  assertPrivateDirectory(credentialsDirectory);
  assertPrivateDirectory(join(credentialsDirectory, "vision"));
  const path = visionCredentialPath(credentialsDirectory);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new Error("视觉 API Key 凭据文件权限无效");
  }
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && status.uid !== currentUserId) {
    throw new Error("视觉 API Key 凭据文件所有者无效");
  }
  if (status.size <= 0 || status.size > maximumApiKeyBytes) {
    throw new Error("视觉 API Key 凭据文件大小无效");
  }
  return validateVisionApiKey(readFileSync(path, "utf8"));
}

export function writeVisionApiKey(credentialsDirectory, apiKey) {
  const value = validateVisionApiKey(apiKey);
  const directory = join(credentialsDirectory, "vision");
  const path = visionCredentialPath(credentialsDirectory);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  ensurePrivateDirectory(credentialsDirectory);
  ensurePrivateDirectory(directory);
  try {
    writeFileSync(temporaryPath, `${value}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function removeVisionApiKey(credentialsDirectory) {
  if (!existsSync(credentialsDirectory)) return;
  assertPrivateDirectory(credentialsDirectory);
  const directory = join(credentialsDirectory, "vision");
  if (!existsSync(directory)) return;
  assertPrivateDirectory(directory);
  const path = visionCredentialPath(credentialsDirectory);
  rmSync(path, { force: true });
  try {
    rmdirSync(directory);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY") throw error;
  }
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  assertPrivateDirectory(path);
  chmodSync(path, 0o700);
}

function assertPrivateDirectory(path) {
  const status = lstatSync(path);
  const currentUserId = process.getuid?.();
  if (
    !status.isDirectory()
    || status.isSymbolicLink()
    || (currentUserId !== undefined && status.uid !== currentUserId)
    || (status.mode & 0o077) !== 0
  ) {
    throw new Error("视觉 API Key 凭据目录权限无效");
  }
}

function validateVisionApiKey(value) {
  if (typeof value !== "string") throw new Error("视觉 API Key 无效");
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || Buffer.byteLength(trimmed, "utf8") > maximumApiKeyBytes
    || [...trimmed].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    throw new Error("视觉 API Key 无效");
  }
  return trimmed;
}
