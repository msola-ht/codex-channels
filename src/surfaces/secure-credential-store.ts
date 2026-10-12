import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  readWindowsSecureRecordSync,
  removeWindowsSecureRecordSync,
  writeWindowsSecureRecordSync,
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
  private readonly masterKeyPath: string;

  constructor(private readonly directory: string) {
    this.masterKeyPath = join(directory, "master.key");
  }

  async get(key: string): Promise<string | null> {
    let payload: Buffer;
    try {
      payload = await readFile(this.recordPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return decrypt(payload, await this.readMasterKey());
  }

  async set(key: string, value: string): Promise<void> {
    await this.ensureDirectory();
    const encryptionKey = await this.readOrCreateMasterKey();
    const path = this.recordPath(key);
    const temporaryPath =
      `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, encrypt(value, encryptionKey), {
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The temporary file may not exist or may already have been renamed.
      }
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.recordPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }

  private async readMasterKey(): Promise<Buffer> {
    const key = await readFile(this.masterKeyPath);
    if (key.length !== keyBytes) {
      throw new Error("凭据主密钥无效");
    }
    return key;
  }

  private async readOrCreateMasterKey(): Promise<Buffer> {
    try {
      return await this.readMasterKey();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await this.ensureDirectory();
    const key = randomBytes(keyBytes);
    try {
      await writeFile(this.masterKeyPath, key, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return this.readMasterKey();
      }
      throw error;
    }
    await chmod(this.masterKeyPath, 0o600);
    return key;
  }

  private recordPath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `${digest}.enc`);
  }
}

export class WindowsDpapiCredentialRecordStore
implements SecureCredentialRecordStore {
  constructor(private readonly directory: string) {}

  get(key: string): Promise<string | null> {
    return Promise.resolve(readWindowsSecureRecordSync(this.directory, key));
  }

  set(key: string, value: string): Promise<void> {
    writeWindowsSecureRecordSync(this.directory, key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    removeWindowsSecureRecordSync(this.directory, key);
    return Promise.resolve();
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
