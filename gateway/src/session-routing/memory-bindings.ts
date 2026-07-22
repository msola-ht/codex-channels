import type { ConversationTarget } from "../conversation-core/events.js";

export interface ConversationBinding {
  target: ConversationTarget;
  threadId: string;
  sessionId: string;
}

export class MemoryBindingStore {
  private readonly byConversation = new Map<string, ConversationBinding>();
  private readonly byThread = new Map<string, ConversationBinding>();

  get(target: ConversationTarget): ConversationBinding | undefined {
    return this.byConversation.get(this.key(target));
  }

  getByThread(threadId: string): ConversationBinding | undefined {
    return this.byThread.get(threadId);
  }

  list(): ConversationBinding[] {
    return [...this.byConversation.values()];
  }

  bind(binding: ConversationBinding): void {
    const conversationKey = this.key(binding.target);
    const previous = this.byConversation.get(conversationKey);
    if (previous && previous.threadId !== binding.threadId) {
      this.byThread.delete(previous.threadId);
    }
    const owner = this.byThread.get(binding.threadId);
    if (owner && this.key(owner.target) !== conversationKey) {
      throw new Error("该 Codex Thread 已绑定到其他会话");
    }
    this.byConversation.set(conversationKey, binding);
    this.byThread.set(binding.threadId, binding);
  }

  unbind(target: ConversationTarget): ConversationBinding | undefined {
    const key = this.key(target);
    const binding = this.byConversation.get(key);
    if (binding) {
      this.byConversation.delete(key);
      this.byThread.delete(binding.threadId);
    }
    return binding;
  }

  private key(target: ConversationTarget): string {
    return `${target.surface}:${target.conversationId}`;
  }
}
