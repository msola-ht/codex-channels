import type { ConversationTarget } from "../conversation-core/events.js";
import type { BindingStore, ConversationBinding } from "./binding-store.js";

export class MemoryBindingStore implements BindingStore {
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
    const owner = this.byThread.get(binding.threadId);
    if (owner && this.key(owner.target) !== conversationKey) {
      throw new Error("该 Codex Thread 已绑定到其他会话");
    }
    const previous = this.byConversation.get(conversationKey);
    if (previous && previous.threadId !== binding.threadId) {
      this.byThread.delete(previous.threadId);
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

  close(): void {}

  private key(target: ConversationTarget): string {
    return `${target.surface}:${target.conversationId}`;
  }
}
