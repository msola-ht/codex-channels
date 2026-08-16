import {
  EncryptedFileCredentialRecordStore,
  MacKeychainCredentialRecordStore,
  type KeychainCommandRunner,
  type SecureCredentialRecordStore,
} from "../secure-credential-store.js";

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
const maximumStoredScopes = 1_000;
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
  private readonly records: SecureCredentialRecordStore;

  constructor(
    run?: KeychainCommandRunner,
  ) {
    this.records = new MacKeychainCredentialRecordStore(
      keychainService,
      run,
    );
  }

  async get(
    appId: string,
    userOpenId: string,
  ): Promise<StoredFeishuUserToken | null> {
    const value = await this.records.get(accountKey(appId, userOpenId));
    return value === null
      ? null
      : parseStoredToken(value, appId, userOpenId);
  }

  async set(token: StoredFeishuUserToken): Promise<void> {
    const account = accountKey(token.appId, token.userOpenId);
    await this.records.set(account, JSON.stringify(token));
  }

  async remove(appId: string, userOpenId: string): Promise<void> {
    await this.records.remove(accountKey(appId, userOpenId));
  }
}

export class EncryptedFileFeishuUserTokenStore
implements FeishuUserTokenStore {
  private readonly records: SecureCredentialRecordStore;

  constructor(directory: string) {
    this.records = new EncryptedFileCredentialRecordStore(directory);
  }

  async get(
    appId: string,
    userOpenId: string,
  ): Promise<StoredFeishuUserToken | null> {
    try {
      const value = await this.records.get(accountKey(appId, userOpenId));
      if (value === null) {
        return null;
      }
      const token = parseStoredToken(value, appId, userOpenId);
      if (!token) {
        throw new Error("飞书加密凭据载荷无效");
      }
      return token;
    } catch (error) {
      throw new Error("读取飞书加密凭据失败", { cause: error });
    }
  }

  async set(token: StoredFeishuUserToken): Promise<void> {
    await this.records.set(
      accountKey(token.appId, token.userOpenId),
      JSON.stringify(token),
    );
  }

  async remove(appId: string, userOpenId: string): Promise<void> {
    await this.records.remove(accountKey(appId, userOpenId));
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
