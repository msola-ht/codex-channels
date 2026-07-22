import type { ConversationTarget } from "../conversation-core/events.js";
import type { BindingStore, ConversationBinding } from "./binding-store.js";

export class MemoryBindingStore implements BindingStore {
  private readonly workspaceByConversation = new Map<string, string>();
  private readonly byConversation = new Map<string, ConversationBinding>();
  private readonly byThread = new Map<string, ConversationBinding>();

  getWorkspace(target: ConversationTarget): string | undefined {
    return this.workspaceByConversation.get(this.key(target));
  }

  selectWorkspace(target: ConversationTarget, workspaceId: string): void {
    const key = this.key(target);
    const binding = this.byConversation.get(key);
    if (binding && binding.workspaceId !== workspaceId) {
      throw new Error("切换 Workspace 前必须先解除当前 Thread 绑定");
    }
    this.workspaceByConversation.set(key, workspaceId);
  }

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
    this.workspaceByConversation.set(conversationKey, binding.workspaceId);
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
