import type { ConversationTarget } from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import type { FeishuCardAction } from "./card-action.js";

interface CardActionBinding {
  target: ConversationTarget;
  actorId: string;
  messageId: string;
}

/** 仅保留短期归属以回执失效点击，不保留或恢复可执行动作。 */
export class FeishuExpiredCardActions {
  private readonly bindings = new Map<string, CardActionBinding & { expiresAt: number }>();

  remember(token: string, binding: CardActionBinding, now: number): void {
    this.prune(now);
    this.bindings.set(token, {
      target: binding.target,
      actorId: binding.actorId,
      messageId: binding.messageId,
      expiresAt: now + 10 * 60_000,
    });
    while (this.bindings.size > 100) {
      const first = this.bindings.keys().next();
      if (first.done) break;
      this.bindings.delete(first.value);
    }
  }

  take(token: string, action: FeishuCardAction, access: SurfaceAccessPolicy, now: number): ConversationTarget | undefined {
    this.prune(now);
    const binding = this.bindings.get(token);
    if (!binding || binding.messageId !== action.messageId
      || binding.target.conversationId !== action.chatId
      || binding.actorId !== action.actorOpenId
      || !access.isAllowed(binding)) return undefined;
    this.bindings.delete(token);
    return binding.target;
  }

  clear(): void {
    this.bindings.clear();
  }

  private prune(now: number): void {
    for (const [token, binding] of this.bindings) {
      if (binding.expiresAt <= now) this.bindings.delete(token);
    }
  }
}
