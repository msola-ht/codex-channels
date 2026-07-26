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

export interface StoredFeishuUserToken {
  appId: string;
  userOpenId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scopes: readonly string[];
  grantedAt: number;
}

export interface FeishuUserTokenStore {
  get(appId: string, userOpenId: string): Promise<StoredFeishuUserToken | null>;
  set(token: StoredFeishuUserToken): Promise<void>;
  remove(appId: string, userOpenId: string): Promise<void>;
}

const keychainService = "codexc-feishu-uat";
const executeFile = promisify(execFile);
const keychainCommandTimeoutMs = 5_000;
const keyBytes = 32;
const ivBytes = 12;
const tagBytes = 16;
const maximumStoredScopes = 101;
const maximumStoredScopeLength = 128;
const maximumStoredScopeBytes = 8_192;
const maximumStoredTokenLength = 16_384;
const storedScopePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function createFeishuUserTokenStore(
  credentialsDirectory: string,
  platform: NodeJS.Platform = process.platform,
): FeishuUserTokenStore {
  if (platform === "darwin") {
    return new MacKeychainFeishuUserTokenStore();
  }
  if (platform === "linux") {
    return new EncryptedFileFeishuUserTokenStore(credentialsDirectory);
  }
  throw new Error(`飞书用户授权不支持当前平台：${platform}`);
}

export class MacKeychainFeishuUserTokenStore
implements FeishuUserTokenStore {
  constructor(
    private readonly run: (
      file: string,
      arguments_: readonly string[],
    ) => Promise<{ stdout: string | Buffer }> = runKeychainCommand,
  ) {}

  async get(
    appId: string,
    userOpenId: string,
  ): Promise<StoredFeishuUserToken | null> {
    try {
      const { stdout } = await this.run("security", [
        "find-generic-password",
        "-s",
        keychainService,
        "-a",
        accountKey(appId, userOpenId),
        "-w",
      ]);
      return parseStoredToken(String(stdout).trim(), appId, userOpenId);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 44 || code === "44") {
        return null;
      }
      throw error;
    }
  }

  async set(token: StoredFeishuUserToken): Promise<void> {
    const account = accountKey(token.appId, token.userOpenId);
    await this.run("security", [
      "add-generic-password",
      "-U",
      "-s",
      keychainService,
      "-a",
      account,
      "-w",
      JSON.stringify(token),
    ]);
  }

  async remove(appId: string, userOpenId: string): Promise<void> {
    try {
      await this.run("security", [
        "delete-generic-password",
        "-s",
        keychainService,
        "-a",
        accountKey(appId, userOpenId),
      ]);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 44 && code !== "44") {
        throw error;
      }
    }
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

export class EncryptedFileFeishuUserTokenStore
implements FeishuUserTokenStore {
  private readonly masterKeyPath: string;

  constructor(private readonly directory: string) {
    this.masterKeyPath = join(directory, "master.key");
  }

  async get(
    appId: string,
    userOpenId: string,
  ): Promise<StoredFeishuUserToken | null> {
    let payload: Buffer;
    try {
      payload = await readFile(this.tokenPath(appId, userOpenId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error("读取飞书加密凭据失败", { cause: error });
    }
    try {
      const key = await this.readMasterKey();
      const token = parseStoredToken(
        decrypt(payload, key),
        appId,
        userOpenId,
      );
      if (!token) {
        throw new Error("飞书加密凭据载荷无效");
      }
      return token;
    } catch (error) {
      throw new Error("读取飞书加密凭据失败", { cause: error });
    }
  }

  async set(token: StoredFeishuUserToken): Promise<void> {
    await this.ensureDirectory();
    const key = await this.readOrCreateMasterKey();
    const path = this.tokenPath(token.appId, token.userOpenId);
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        encrypt(JSON.stringify(token), key),
        { flag: "wx", mode: 0o600 },
      );
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

  async remove(appId: string, userOpenId: string): Promise<void> {
    try {
      await unlink(this.tokenPath(appId, userOpenId));
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
      throw new Error("飞书凭据主密钥无效");
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

  private tokenPath(appId: string, userOpenId: string): string {
    const digest = createHash("sha256")
      .update(accountKey(appId, userOpenId))
      .digest("hex");
    return join(this.directory, `${digest}.enc`);
  }
}

export function feishuTokenStatus(
  token: StoredFeishuUserToken | null,
  now = Date.now(),
): "missing" | "valid" | "refreshable" | "expired" {
  if (!token) {
    return "missing";
  }
  if (now < token.expiresAt - 5 * 60_000) {
    return "valid";
  }
  if (token.refreshToken && now < token.refreshExpiresAt) {
    return "refreshable";
  }
  return "expired";
}

function accountKey(appId: string, userOpenId: string): string {
  return `${appId}:${userOpenId}`;
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
    throw new Error("飞书凭据密文无效");
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

function parseStoredToken(
  value: string,
  appId: string,
  userOpenId: string,
): StoredFeishuUserToken | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.appId !== appId
      || parsed.userOpenId !== userOpenId
      || typeof parsed.accessToken !== "string"
      || parsed.accessToken.length === 0
      || parsed.accessToken.length > maximumStoredTokenLength
      || typeof parsed.refreshToken !== "string"
      || parsed.refreshToken.length > maximumStoredTokenLength
      || typeof parsed.expiresAt !== "number"
      || typeof parsed.refreshExpiresAt !== "number"
      || typeof parsed.grantedAt !== "number"
      || !Number.isFinite(parsed.expiresAt)
      || !Number.isFinite(parsed.refreshExpiresAt)
      || !Number.isFinite(parsed.grantedAt)
      || !Number.isSafeInteger(parsed.expiresAt)
      || !Number.isSafeInteger(parsed.refreshExpiresAt)
      || !Number.isSafeInteger(parsed.grantedAt)
      || parsed.grantedAt <= 0
      || parsed.expiresAt <= parsed.grantedAt
      || parsed.refreshExpiresAt < parsed.expiresAt
      || !Array.isArray(parsed.scopes)
      || parsed.scopes.length > maximumStoredScopes
      || !parsed.scopes.every((scope) =>
        typeof scope === "string"
        && scope.length <= maximumStoredScopeLength
        && storedScopePattern.test(scope)
      )
      || Buffer.byteLength(parsed.scopes.join(" "), "utf8")
        > maximumStoredScopeBytes
    ) {
      return null;
    }
    return {
      appId,
      userOpenId,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      refreshExpiresAt: parsed.refreshExpiresAt,
      grantedAt: parsed.grantedAt,
      scopes: parsed.scopes,
    };
  } catch {
    return null;
  }
}
