import {
  EncryptedFileCredentialRecordStore,
  MacKeychainCredentialRecordStore,
  type KeychainCommandRunner,
  type SecureCredentialRecordStore,
} from "../secure-credential-store.js";

export interface StoredWeixinCredential {
  version: 1;
  accountId: string;
  botToken: string;
  baseUrl: string;
  grantedAt: number;
}

export interface WeixinCredentialStore {
  get(accountId: string): Promise<StoredWeixinCredential | null>;
  set(credential: StoredWeixinCredential): Promise<void>;
  remove(accountId: string): Promise<void>;
}

const keychainService = "codexc-weixin-bot-token";
const maximumTokenLength = 16_384;

class StrictWeixinCredentialStore implements WeixinCredentialStore {
  constructor(private readonly records: SecureCredentialRecordStore) {}

  async get(accountId: string): Promise<StoredWeixinCredential | null> {
    validateAccountId(accountId);
    try {
      const value = await this.records.get(accountId);
      if (value === null) {
        return null;
      }
      return parseStoredCredential(value, accountId);
    } catch (error) {
      throw new Error("读取微信加密凭据失败", { cause: error });
    }
  }

  async set(credential: StoredWeixinCredential): Promise<void> {
    const validated = validateCredential(credential, credential.accountId);
    await this.records.set(
      validated.accountId,
      JSON.stringify(validated),
    );
  }

  async remove(accountId: string): Promise<void> {
    validateAccountId(accountId);
    await this.records.remove(accountId);
  }
}

export function createWeixinCredentialStore(
  credentialsDirectory: string,
  platform: NodeJS.Platform = process.platform,
): WeixinCredentialStore {
  if (platform === "darwin") {
    return new StrictWeixinCredentialStore(
      new MacKeychainCredentialRecordStore(keychainService),
    );
  }
  if (platform === "linux") {
    return new StrictWeixinCredentialStore(
      new EncryptedFileCredentialRecordStore(credentialsDirectory),
    );
  }
  throw new Error(`微信凭据不支持当前平台：${platform}`);
}

export class MacKeychainWeixinCredentialStore
extends StrictWeixinCredentialStore {
  constructor(run?: KeychainCommandRunner) {
    super(new MacKeychainCredentialRecordStore(keychainService, run));
  }
}

export class EncryptedFileWeixinCredentialStore
extends StrictWeixinCredentialStore {
  constructor(directory: string) {
    super(new EncryptedFileCredentialRecordStore(directory));
  }
}

function parseStoredCredential(
  value: string,
  accountId: string,
): StoredWeixinCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("微信凭据载荷无效");
  }
  return validateCredential(parsed, accountId);
}

function validateCredential(
  value: unknown,
  expectedAccountId: string,
): StoredWeixinCredential {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error("微信凭据载荷无效");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !== "accountId,baseUrl,botToken,grantedAt,version"
    || record.version !== 1
    || record.accountId !== expectedAccountId
    || typeof record.botToken !== "string"
    || record.botToken.length === 0
    || record.botToken.length > maximumTokenLength
    || typeof record.grantedAt !== "number"
    || !Number.isSafeInteger(record.grantedAt)
    || record.grantedAt <= 0
  ) {
    throw new Error("微信凭据载荷无效");
  }
  const accountId = validateAccountId(record.accountId);
  const baseUrl = validateWeixinBaseUrl(record.baseUrl);
  return {
    version: 1,
    accountId,
    botToken: record.botToken,
    baseUrl,
    grantedAt: record.grantedAt,
  };
}

export function validateWeixinAccountId(value: unknown): string {
  return validateAccountId(value);
}

export function validateWeixinActorId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 1_024
    || !/^[^\s@]{1,1000}@im\.wechat$/u.test(value)
  ) {
    throw new Error("微信用户 ID 无效");
  }
  return value;
}

export function validateWeixinBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("微信业务 Base URL 无效");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("微信业务 Base URL 无效");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || (
      hostname !== "weixin.qq.com"
      && !hostname.endsWith(".weixin.qq.com")
    )
  ) {
    throw new Error("微信业务 Base URL 无效");
  }
  return url.origin;
}

function validateAccountId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 1_024
    || !/^[^\s@]{1,1000}@im\.bot$/u.test(value)
  ) {
    throw new Error("微信账号 ID 无效");
  }
  return value;
}
