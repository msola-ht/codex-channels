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
import { link, lstat, mkdir, rm, writeFile } from "node:fs/promises";

import {
  assertPrivateDirectoryAccessSync,
  assertPrivateDirectoryAccess,
  readPrivateFileSync,
  readPrivateConfigFile,
  securePrivateDirectorySync,
  securePrivateDirectory,
  securePrivateFileSync,
  securePrivateFile,
  writePrivateFileAtomicSync,
  writePrivateFileAtomic,
} from "./private-file.mjs";
import {
  protectForCurrentWindowsUserSync,
  protectForCurrentWindowsUser,
  unprotectForCurrentWindowsUserSync,
  unprotectForCurrentWindowsUser,
} from "./windows-dpapi.mjs";

const keyBytes = 32;
const ivBytes = 12;
const tagBytes = 16;
const maximumMasterKeyFileBytes = 4_096;
const maximumRecordFileBytes = 1_048_576;
const recordOperationTimeoutMs = 15_000;
const directoryOperations = new Map();
let pendingRecordOperations = 0;

/** Serialize key creation and mutations without blocking the Gateway event loop. */
async function runWindowsRecordOperation(directory, operation, { signal } = {}) {
  assertWindowsPlatform();
  signal?.throwIfAborted();
  if (pendingRecordOperations >= 16) throw new Error("Windows 凭据请求繁忙");
  const cancellation = new AbortController();
  const effectiveSignal = signal ? globalThis.AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  const timer = setTimeout(() => cancellation.abort(new Error("Windows 凭据操作超过总期限；未确认操作结果")), recordOperationTimeoutMs);
  const previous = directoryOperations.get(directory) ?? Promise.resolve();
  pendingRecordOperations++;
  const current = previous.catch(() => {}).then(() => {
    effectiveSignal.throwIfAborted();
    return operation(effectiveSignal);
  });
  directoryOperations.set(directory, current);
  try { return await current; }
  finally {
    clearTimeout(timer);
    pendingRecordOperations--;
    if (directoryOperations.get(directory) === current) directoryOperations.delete(directory);
  }
}

export function readWindowsSecureRecord(directory, key, environment = process.env, options = {}) {
  return runWindowsRecordOperation(directory, async signal => {
    const path = recordPath(directory, key);
    if (!await credentialDirectoryExists(directory, signal)) return null;
    let content;
    try { content = await readPrivateConfigFile(path, { signal, maximumBytes: maximumRecordFileBytes }); }
    catch (error) {
      // Windows ACL failures are intentionally not converted to a missing record.
      signal.throwIfAborted();
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const record = parseEnvelope(content, "record");
    const master = await readMasterKeyAsync(directory, environment, signal);
    signal.throwIfAborted();
    return decryptRecord(Buffer.from(record.data, "base64"), master);
  }, options);
}

export function writeWindowsSecureRecord(directory, key, value, environment = process.env, options = {}) {
  return runWindowsRecordOperation(directory, async signal => {
    const path = recordPath(directory, key);
    const recordOverhead = Buffer.byteLength(`${JSON.stringify({ version: 1, cipher: "aes-256-gcm", data: "" })}\n`);
    if (typeof value !== "string"
      || recordOverhead + 4 * Math.ceil((Buffer.byteLength(value, "utf8") + ivBytes + tagBytes) / 3) > maximumRecordFileBytes) {
      throw new Error("Windows 凭据记录无效或超过上限");
    }
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await securePrivateDirectory(dirname(directory), { signal });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await securePrivateDirectory(directory, { signal });
    const master = await readOrCreateMasterKeyAsync(directory, environment, signal);
    signal.throwIfAborted();
    const encrypted = encryptRecord(value, master);
    await writePrivateFileAtomic(path, `${JSON.stringify({ version: 1, cipher: "aes-256-gcm", data: encrypted.toString("base64") })}\n`, { signal });
  }, options);
}

export function removeWindowsSecureRecord(directory, key, options = {}) {
  return runWindowsRecordOperation(directory, async signal => {
    const path = recordPath(directory, key);
    if (!await credentialDirectoryExists(directory, signal)) return;
    signal.throwIfAborted();
    await rm(path, { force: true });
  }, options);
}

async function credentialDirectoryExists(directory, signal) {
  try { await lstat(directory); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  await assertPrivateDirectoryAccess(dirname(directory), { signal });
  await assertPrivateDirectoryAccess(directory, { signal });
  signal.throwIfAborted();
  return true;
}

async function readMasterKeyAsync(directory, environment, signal) {
  const envelope = parseEnvelope(await readPrivateConfigFile(masterKeyPath(directory), { signal, maximumBytes: maximumMasterKeyFileBytes }), "master");
  const key = await unprotectForCurrentWindowsUser(Buffer.from(envelope.data, "base64"), environment, { signal });
  if (key.length !== keyBytes) throw new Error("Windows 凭据主密钥无效");
  return key;
}

async function readOrCreateMasterKeyAsync(directory, environment, signal) {
  const path = masterKeyPath(directory);
  let exists = true;
  try { await lstat(path); }
  catch (error) { if (error?.code !== "ENOENT") throw error; exists = false; }
  if (exists) return readMasterKeyAsync(directory, environment, signal);
  const key = randomBytes(keyBytes);
  const protectedKey = await protectForCurrentWindowsUser(key, environment, { signal });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, protection: "dpapi-current-user", data: protectedKey.toString("base64") })}\n`, { flag: "wx", mode: 0o600, signal });
    await securePrivateFile(temporaryPath, { signal });
    signal.throwIfAborted();
    // Publish only complete protected content, without replacing another writer's key.
    try { await link(temporaryPath, path); }
    catch (error) { if (error?.code === "EEXIST") return await readMasterKeyAsync(directory, environment, signal); throw error; }
    return key;
  } finally { await rm(temporaryPath, { force: true }); }
}

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
