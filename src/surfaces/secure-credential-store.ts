import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectPrivateDirectoryAccess } from "../../runtime/private-file.mjs";

import {
  readWindowsSecureRecord,
  removeWindowsSecureRecord,
  writeWindowsSecureRecord,
} from "../../runtime/windows-secure-record.mjs";

export interface SecureCredentialRecordStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type KeychainCommandRunner = (
  file: string,
  arguments_: readonly string[],
) => Promise<{ stdout: string | Buffer }>;

const executeFile = promisify(execFile);
const keychainCommandTimeoutMs = 5_000;
const keyBytes = 32;
const ivBytes = 12;
const tagBytes = 16;
const maximumRecordBytes = 1_048_576;

interface CredentialFileSnapshot {
  content: Buffer;
  metadata: Stats;
}

type KeychainOperation = "get" | "set" | "remove";
type KeychainFailureReason = "timeout" | "unavailable" | "permission-denied" | "command-failed";

export class KeychainCredentialStoreError extends Error {
  readonly code = "credential-store-failed";

  constructor(
    readonly operation: KeychainOperation,
    readonly reason: KeychainFailureReason,
    readonly exitCode?: number,
  ) {
    const operationLabel = { get: "读取", set: "保存", remove: "删除" }[operation];
    const reasonLabel = {
      timeout: "命令超时",
      unavailable: "系统钥匙串命令不可用",
      "permission-denied": "权限不足",
      "command-failed": "系统钥匙串命令失败",
    }[reason];
    super(`${operationLabel}安全凭据失败：${reasonLabel}${exitCode === undefined ? "" : `（退出码 ${exitCode}）`}`);
    this.name = "KeychainCredentialStoreError";
  }
}

export class MacKeychainCredentialRecordStore
implements SecureCredentialRecordStore {
  constructor(
    private readonly service: string,
    private readonly run: KeychainCommandRunner = runKeychainCommand,
  ) {}

  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await this.run("security", [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        key,
        "-w",
      ]);
      return String(stdout).trim();
    } catch (error) {
      const code = keychainErrorFields(error).code;
      if (code === 44 || code === "44") {
        return null;
      }
      throw safeKeychainError(error, "get");
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.run("security", [
        "add-generic-password",
        "-U",
        "-s",
        this.service,
        "-a",
        key,
        "-w",
        value,
      ]);
    } catch (error) {
      throw safeKeychainError(error, "set");
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.run("security", [
        "delete-generic-password",
        "-s",
        this.service,
        "-a",
        key,
      ]);
    } catch (error) {
      const code = keychainErrorFields(error).code;
      if (code !== 44 && code !== "44") {
        throw safeKeychainError(error, "remove");
      }
    }
  }
}

function keychainErrorFields(error: unknown): { code?: unknown; killed?: unknown } {
  return typeof error === "object" && error !== null ? error : {};
}

function safeKeychainError(error: unknown, operation: KeychainOperation): KeychainCredentialStoreError {
  const { code, killed } = keychainErrorFields(error);
  const reason = killed === true || code === "ETIMEDOUT"
    ? "timeout"
    : code === "ENOENT"
      ? "unavailable"
      : code === "EACCES" || code === "EPERM"
        ? "permission-denied"
        : "command-failed";
  const exitCode = typeof code === "number" && Number.isSafeInteger(code)
    ? code
    : undefined;
  // execFile errors contain the complete command, credential arguments and stderr.
  // Preserve only closed failure classifications; never retain the original cause.
  return new KeychainCredentialStoreError(operation, reason, exitCode);
}

export class EncryptedFileCredentialRecordStore
implements SecureCredentialRecordStore {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<string | null> {
    return this.inDirectory(false, async (directory, verifyDirectory) => {
      const path = this.recordPath(directory, key);
      let payload: CredentialFileSnapshot;
      try {
        payload = await readCredentialFile(path, maximumRecordBytes, verifyDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const encryptionKey = await this.readMasterKey(directory, verifyDirectory);
      const value = decrypt(payload.content, encryptionKey.content);
      await verifyDirectory();
      await requireCredentialIdentity(path, payload.metadata, verifyDirectory);
      await requireCredentialIdentity(join(directory, "master.key"), encryptionKey.metadata, verifyDirectory);
      return value;
    });
  }

  async set(key: string, value: string): Promise<void> {
    if (Buffer.byteLength(value, "utf8") + ivBytes + tagBytes > maximumRecordBytes) {
      throw new Error("凭据记录超过大小上限");
    }
    await this.inDirectory(true, async (directory, verifyDirectory) => {
      const path = this.recordPath(directory, key);
      const previous = await credentialMetadata(path, verifyDirectory);
      const encryptionKey = await this.readOrCreateMasterKey(directory, verifyDirectory);
      const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      let temporary: FileHandle | undefined;
      try {
        await verifyDirectory();
        temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await temporary.writeFile(encrypt(value, encryptionKey.content));
        await temporary.sync();
        const temporaryMetadata = await temporary.stat();
        validateCredentialMetadata(temporaryMetadata, maximumRecordBytes);
        await verifyDirectory();
        const current = await credentialMetadata(path, verifyDirectory);
        if (!sameCredentialRevision(previous, current)) throw new Error("凭据记录在保存期间发生变化");
        await requireCredentialIdentity(temporaryPath, temporaryMetadata, verifyDirectory);
        await requireCredentialIdentity(join(directory, "master.key"), encryptionKey.metadata, verifyDirectory);
        await rename(temporaryPath, path);
      } finally {
        if (temporary) {
          // Operate through the held Linux directory descriptor, never a replaced parent path.
          try {
            await requireCredentialIdentity(temporaryPath, await temporary.stat(), verifyDirectory);
            await unlink(temporaryPath);
          } catch {
            // A renamed/missing/replaced temporary entry is not ours to remove.
          }
          await temporary.close();
        }
      }
      await verifyDirectory();
      await requireCredentialIdentity(join(directory, "master.key"), encryptionKey.metadata, verifyDirectory);
    });
  }

  async remove(key: string): Promise<void> {
    await this.inDirectory(false, async (directory, verifyDirectory) => {
      const path = this.recordPath(directory, key);
      const metadata = await credentialMetadata(path, verifyDirectory);
      if (!metadata) return;
      await verifyDirectory();
      await requireCredentialIdentity(path, metadata, verifyDirectory);
      await unlink(path);
    });
  }

  private async inDirectory<T>(
    create: boolean,
    operation: (directory: string, verify: () => Promise<void>) => Promise<T>,
  ): Promise<T | null> {
    // This backend is Linux-only; macOS and Windows use their dedicated stores.
    if (process.platform !== "linux") throw new Error("加密文件凭据后端仅支持 Linux");
    const path = resolve(this.directory);
    await rejectCredentialAncestorLinks(path);
    let identity;
    try {
      identity = await inspectPrivateDirectoryAccess(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return null;
      await mkdir(path, { recursive: true, mode: 0o700 });
      identity = await inspectPrivateDirectoryAccess(path);
    }
    const descriptor = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const held = await descriptor.stat();
      const directory = `/proc/self/fd/${descriptor.fd}`;
      const verify = async (): Promise<void> => {
        // A missing procfs capability is an infrastructure failure, never a missing record.
        let reachable: Stats;
        try {
          reachable = await stat(directory);
        } catch {
          throw new Error("凭据目录描述符访问不可用");
        }
        if (!reachable.isDirectory() || reachable.dev !== held.dev || reachable.ino !== held.ino) {
          throw new Error("凭据目录描述符身份无效");
        }
        try {
          await rejectCredentialAncestorLinks(path);
          const current = await inspectPrivateDirectoryAccess(path);
          if (!held.isDirectory() || held.dev !== identity.dev || held.ino !== identity.ino
            || current.dev !== held.dev || current.ino !== held.ino) {
            throw new Error("凭据目录在操作期间发生变化");
          }
        } catch (error) {
          // Once held, losing the configured directory must not resemble a missing leaf.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("凭据目录在操作期间发生变化", { cause: error });
          }
          throw error;
        }
      };
      await verify();
      const result = await operation(directory, verify);
      await verify();
      return result;
    } finally {
      await descriptor.close();
    }
  }

  private async readMasterKey(directory: string, verifyDirectory: () => Promise<void>): Promise<CredentialFileSnapshot> {
    const key = await readCredentialFile(join(directory, "master.key"), keyBytes, verifyDirectory);
    if (key.content.length !== keyBytes) {
      throw new Error("凭据主密钥无效");
    }
    return key;
  }

  private async readOrCreateMasterKey(directory: string, verifyDirectory: () => Promise<void>): Promise<CredentialFileSnapshot> {
    try {
      return await this.readMasterKey(directory, verifyDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    // Never replace a lost key for a directory that already contains records.
    const entries = await readdir(directory);
    if (entries.includes("master.key")) return this.readMasterKey(directory, verifyDirectory);
    if (entries.length > 0) throw new Error("凭据主密钥缺失，保留现有材料");
    const key = randomBytes(keyBytes);
    await verifyDirectory();
    let descriptor: FileHandle;
    try {
      descriptor = await open(join(directory, "master.key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return this.readMasterKey(directory, verifyDirectory);
      }
      throw error;
    }
    try {
      await descriptor.writeFile(key);
      await descriptor.sync();
      await verifyDirectory();
      const metadata = await descriptor.stat();
      validateCredentialMetadata(metadata, keyBytes);
      await requireCredentialIdentity(join(directory, "master.key"), metadata, verifyDirectory);
      return { content: key, metadata };
    } finally {
      await descriptor.close();
    }
  }

  private recordPath(directory: string, key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(directory, `${digest}.enc`);
  }
}

async function rejectCredentialAncestorLinks(path: string): Promise<void> {
  let existing = path;
  for (;;) {
    try {
      if (await realpath(existing) !== existing) throw new Error("凭据目录路径不能包含符号链接");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

function validateCredentialMetadata(metadata: Stats, maximumBytes = Number.POSITIVE_INFINITY): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0
    || metadata.size > maximumBytes) throw new Error("凭据文件类型、权限、归属或大小无效");
}

async function credentialMetadata(path: string, verifyDirectory: () => Promise<void>): Promise<Stats | null> {
  try {
    const metadata = await lstat(path);
    validateCredentialMetadata(metadata);
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await verifyDirectory();
      return null;
    }
    throw error;
  }
}

function sameCredentialRevision(left: Stats | null, right: Stats | null): boolean {
  return left === null || right === null ? left === right
    : left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function requireCredentialIdentity(path: string, expected: Stats, verifyDirectory: () => Promise<void>): Promise<void> {
  const current = await credentialMetadata(path, verifyDirectory);
  if (!sameCredentialRevision(expected, current)) throw new Error("凭据文件在操作期间发生变化");
}

async function readCredentialFile(path: string, maximumBytes: number, verifyDirectory: () => Promise<void>): Promise<CredentialFileSnapshot> {
  let descriptor: FileHandle;
  try {
    descriptor = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") await verifyDirectory();
    throw error;
  }
  try {
    const before = await descriptor.stat();
    validateCredentialMetadata(before, maximumBytes);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await descriptor.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumBytes || !sameCredentialRevision(before, await descriptor.stat())) {
      throw new Error("凭据文件在读取期间发生变化或超过上限");
    }
    await requireCredentialIdentity(path, before, verifyDirectory);
    return { content: buffer.subarray(0, length), metadata: before };
  } finally {
    await descriptor.close();
  }
}

export class WindowsDpapiCredentialRecordStore
implements SecureCredentialRecordStore {
  constructor(private readonly directory: string) {}

  get(key: string): Promise<string | null> {
    return readWindowsSecureRecord(this.directory, key);
  }

  set(key: string, value: string): Promise<void> {
    return writeWindowsSecureRecord(this.directory, key, value);
  }

  remove(key: string): Promise<void> {
    return removeWindowsSecureRecord(this.directory, key);
  }
}

async function runKeychainCommand(
  file: string,
  arguments_: readonly string[],
): Promise<{ stdout: string | Buffer }> {
  const { stdout } = await executeFile(file, [...arguments_], {
    timeout: keychainCommandTimeoutMs,
    maxBuffer: 1_048_576,
  });
  return { stdout };
}

function encrypt(value: string, key: Buffer): Buffer {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decrypt(value: Buffer, key: Buffer): string {
  if (value.length <= ivBytes + tagBytes) {
    throw new Error("凭据密文无效");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    value.subarray(0, ivBytes),
  );
  decipher.setAuthTag(value.subarray(ivBytes, ivBytes + tagBytes));
  return Buffer.concat([
    decipher.update(value.subarray(ivBytes + tagBytes)),
    decipher.final(),
  ]).toString("utf8");
}
