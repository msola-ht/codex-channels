import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  assertPrivateDirectoryAccessSync,
  readPrivateFileSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
  writePrivateFileAtomicSync,
} from "./private-file.mjs";
import {
  protectForCurrentWindowsUserSync,
  unprotectForCurrentWindowsUserSync,
} from "./windows-dpapi.mjs";

const keyBytes = 32;
const ivBytes = 12;
const tagBytes = 16;
const maximumMasterKeyFileBytes = 4_096;
const maximumRecordFileBytes = 1_048_576;

export function readWindowsSecureRecordSync(
  directory,
  key,
  environment = process.env,
) {
  assertWindowsPlatform();
  if (!existsSync(directory)) return null;
  assertCredentialDirectory(directory);
  const path = recordPath(directory, key);
  if (!existsSync(path)) return null;
  const record = parseEnvelope(
    readPrivateFileSync(path, maximumRecordFileBytes),
    "record",
  );
  return decryptRecord(
    Buffer.from(record.data, "base64"),
    readMasterKey(directory, environment),
  );
}

export function writeWindowsSecureRecordSync(
  directory,
  key,
  value,
  environment = process.env,
) {
  assertWindowsPlatform();
  if (typeof value !== "string") throw new Error("Windows 凭据记录无效");
  ensureCredentialDirectory(directory);
  const encrypted = encryptRecord(value, readOrCreateMasterKey(directory, environment));
  writePrivateFileAtomicSync(
    recordPath(directory, key),
    `${JSON.stringify({ version: 1, cipher: "aes-256-gcm", data: encrypted.toString("base64") })}\n`,
  );
}

export function removeWindowsSecureRecordSync(directory, key) {
  assertWindowsPlatform();
  if (!existsSync(directory)) return;
  assertCredentialDirectory(directory);
  rmSync(recordPath(directory, key), { force: true });
}

export function windowsSecureRecordPath(directory, key) {
  return recordPath(directory, key);
}

function readOrCreateMasterKey(directory, environment) {
  const path = masterKeyPath(directory);
  if (existsSync(path)) return readMasterKey(directory, environment);
  const key = randomBytes(keyBytes);
  const protectedKey = protectForCurrentWindowsUserSync(key, environment);
  const content = `${JSON.stringify({
    version: 1,
    protection: "dpapi-current-user",
    data: protectedKey.toString("base64"),
  })}\n`;
  try {
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    securePrivateFileSync(path);
    return key;
  } catch (error) {
    if (error?.code === "EEXIST") return readMasterKey(directory, environment);
    rmSync(path, { force: true });
    throw error;
  }
}

function readMasterKey(directory, environment) {
  const envelope = parseEnvelope(
    readPrivateFileSync(masterKeyPath(directory), maximumMasterKeyFileBytes),
    "master",
  );
  const key = unprotectForCurrentWindowsUserSync(
    Buffer.from(envelope.data, "base64"),
    environment,
  );
  if (key.length !== keyBytes) throw new Error("Windows 凭据主密钥无效");
  return key;
}

function parseEnvelope(text, kind) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Windows 凭据文件格式无效");
  }
  const expectedKeys = kind === "master"
    ? "data,protection,version"
    : "cipher,data,version";
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== expectedKeys
    || value.version !== 1
    || (kind === "master" && value.protection !== "dpapi-current-user")
    || (kind === "record" && value.cipher !== "aes-256-gcm")
    || typeof value.data !== "string"
    || value.data.length === 0
  ) {
    throw new Error("Windows 凭据文件格式无效");
  }
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value.data) {
    throw new Error("Windows 凭据文件格式无效");
  }
  return value;
}

function encryptRecord(value, key) {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptRecord(value, key) {
  if (value.length <= ivBytes + tagBytes) throw new Error("Windows 凭据密文无效");
  const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, ivBytes));
  decipher.setAuthTag(value.subarray(ivBytes, ivBytes + tagBytes));
  return Buffer.concat([
    decipher.update(value.subarray(ivBytes + tagBytes)),
    decipher.final(),
  ]).toString("utf8");
}

function ensureCredentialDirectory(directory) {
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  securePrivateDirectorySync(dirname(directory));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  securePrivateDirectorySync(directory);
}

function assertCredentialDirectory(directory) {
  assertPrivateDirectoryAccessSync(dirname(directory));
  assertPrivateDirectoryAccessSync(directory);
}

function masterKeyPath(directory) {
  return join(directory, "master.key.dpapi");
}

function recordPath(directory, key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Windows 凭据记录键无效");
  }
  return join(directory, `${createHash("sha256").update(key).digest("hex")}.enc`);
}

function assertWindowsPlatform() {
  if (process.platform !== "win32") throw new Error("Windows 凭据记录只支持 Windows");
}
