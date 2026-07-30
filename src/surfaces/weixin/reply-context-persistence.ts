import {
  EncryptedFileCredentialRecordStore,
  MacKeychainCredentialRecordStore,
  type KeychainCommandRunner,
  type SecureCredentialRecordStore,
} from "../secure-credential-store.js";
import type { ConversationTarget } from "../../conversation-core/index.js";

import {
  validateWeixinAccountId,
  validateWeixinActorId,
} from "./credential-store.js";

export interface StoredWeixinReplyContext {
  version: 1;
  accountId: string;
  actorId: string;
  contextToken: string;
  updatedAt: number;
}

export interface WeixinReplyContextPersistence {
  get(target: ConversationTarget): Promise<StoredWeixinReplyContext | null>;
  set(
    target: ConversationTarget,
    actorId: string,
    contextToken: string,
  ): Promise<void>;
  remove(target: ConversationTarget): Promise<void>;
}

const keychainService = "codexc-weixin-reply-context";
const maximumContextTokenLength = 65_536;

class StrictWeixinReplyContextPersistence
implements WeixinReplyContextPersistence {
  constructor(
    private readonly records: SecureCredentialRecordStore,
    private readonly now: () => number = Date.now,
  ) {}

  async get(
    target: ConversationTarget,
  ): Promise<StoredWeixinReplyContext | null> {
    const key = targetKey(target);
    try {
      const value = await this.records.get(key);
      return value === null ? null : parseStoredContext(value, target);
    } catch (error) {
      throw new Error("读取微信加密回复上下文失败", { cause: error });
    }
  }

  async set(
    target: ConversationTarget,
    actorId: string,
    contextToken: string,
  ): Promise<void> {
    const record = validateStoredContext({
      version: 1,
      accountId: target.accountId,
      actorId,
      contextToken,
      updatedAt: this.now(),
    }, target);
    await this.records.set(targetKey(target), JSON.stringify(record));
  }

  async remove(target: ConversationTarget): Promise<void> {
    await this.records.remove(targetKey(target));
  }
}

export function createWeixinReplyContextPersistence(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): WeixinReplyContextPersistence {
  if (platform === "darwin") {
    return new StrictWeixinReplyContextPersistence(
      new MacKeychainCredentialRecordStore(keychainService),
    );
  }
  if (platform === "linux") {
    return new StrictWeixinReplyContextPersistence(
      new EncryptedFileCredentialRecordStore(directory),
    );
  }
  throw new Error(`微信回复上下文不支持当前平台：${platform}`);
}

export class MacKeychainWeixinReplyContextPersistence
extends StrictWeixinReplyContextPersistence {
  constructor(run?: KeychainCommandRunner, now?: () => number) {
    super(new MacKeychainCredentialRecordStore(keychainService, run), now);
  }
}

export class EncryptedFileWeixinReplyContextPersistence
extends StrictWeixinReplyContextPersistence {
  constructor(directory: string, now?: () => number) {
    super(new EncryptedFileCredentialRecordStore(directory), now);
  }
}

function parseStoredContext(
  value: string,
  target: ConversationTarget,
): StoredWeixinReplyContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("微信回复上下文载荷无效");
  }
  return validateStoredContext(parsed, target);
}

function validateStoredContext(
  value: unknown,
  target: ConversationTarget,
): StoredWeixinReplyContext {
  assertTarget(target);
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error("微信回复上下文载荷无效");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",")
      !== "accountId,actorId,contextToken,updatedAt,version"
    || record.version !== 1
    || record.accountId !== target.accountId
    || record.actorId !== target.conversationId
    || typeof record.contextToken !== "string"
    || record.contextToken.length === 0
    || record.contextToken.length > maximumContextTokenLength
    || typeof record.updatedAt !== "number"
    || !Number.isSafeInteger(record.updatedAt)
    || record.updatedAt <= 0
  ) {
    throw new Error("微信回复上下文载荷无效");
  }
  return {
    version: 1,
    accountId: validateWeixinAccountId(record.accountId),
    actorId: validateWeixinActorId(record.actorId),
    contextToken: record.contextToken,
    updatedAt: record.updatedAt,
  };
}

function targetKey(target: ConversationTarget): string {
  assertTarget(target);
  return JSON.stringify([target.accountId, target.conversationId]);
}

function assertTarget(target: ConversationTarget): void {
  if (
    target.surface !== "weixin"
    || validateWeixinAccountId(target.accountId) !== target.accountId
    || validateWeixinActorId(target.conversationId) !== target.conversationId
  ) {
    throw new Error("微信回复目标无效");
  }
}
