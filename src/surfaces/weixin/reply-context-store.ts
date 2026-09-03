import type { ConversationTarget } from "../../conversation-core/index.js";

import {
  validateWeixinAccountId,
  validateWeixinActorId,
} from "./credential-store.js";

export interface WeixinReplyContext {
  readonly actorId: string;
  readonly contextToken: string | undefined;
}

const maximumContextTokenLength = 65_536;
const maximumConversationContexts = 1_000;

export class WeixinReplyContextStore {
  private readonly accountId: string;
  private readonly contexts = new Map<string, WeixinReplyContext>();

  constructor(accountId: string) {
    this.accountId = validateWeixinAccountId(accountId);
  }

  remember(
    target: ConversationTarget,
    actorId: string,
    contextToken: string,
  ): void {
    this.assertTarget(target);
    const validatedActorId = validateWeixinActorId(actorId);
    if (
      target.conversationId !== validatedActorId
      || contextToken.length === 0
      || contextToken.length > maximumContextTokenLength
    ) {
      throw new Error("微信回复上下文无效");
    }
    this.contexts.delete(target.conversationId);
    this.contexts.set(target.conversationId, {
      actorId: validatedActorId,
      contextToken,
    });
    while (this.contexts.size > maximumConversationContexts) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.contexts.delete(oldest);
    }
  }

  get(target: ConversationTarget): WeixinReplyContext | undefined {
    this.assertTarget(target);
    const context = this.contexts.get(target.conversationId);
    return context === undefined ? undefined : { ...context };
  }

  remove(target: ConversationTarget): void {
    this.assertTarget(target);
    this.contexts.delete(target.conversationId);
  }

  removeIf(target: ConversationTarget, expectedContextToken: string): boolean {
    this.assertTarget(target);
    const current = this.contexts.get(target.conversationId);
    if (current === undefined || current.contextToken !== expectedContextToken) {
      return false;
    }
    this.contexts.delete(target.conversationId);
    return true;
  }

  clear(): void {
    this.contexts.clear();
  }

  private assertTarget(target: ConversationTarget): void {
    if (
      target.surface !== "weixin"
      || target.accountId !== this.accountId
      || validateWeixinActorId(target.conversationId)
        !== target.conversationId
    ) {
      throw new Error("微信回复目标无效");
    }
  }
}
