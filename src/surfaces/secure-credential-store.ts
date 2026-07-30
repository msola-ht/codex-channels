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
      const code = (error as { code?: unknown }).code;
      if (code === 44 || code === "44") {
        return null;
      }
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
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
      const code = (error as { code?: unknown }).code;
      if (code !== 44 && code !== "44") {
        throw error;
      }
    }
  }
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
