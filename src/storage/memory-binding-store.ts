import { conversationTargetKey, type ConversationTarget } from "../conversation-core/index.js";
import type {
  BindingStore,
  BindingSwitch,
  BindingTransfer,
  ConversationBinding,
} from "./binding-store.js";

export class MemoryBindingStore implements BindingStore {
  private readonly targetsByConversation = new Map<string, ConversationTarget>();
  private readonly workspaceByConversation = new Map<string, string>();
  private readonly byConversation = new Map<string, ConversationBinding>();
  private readonly backgroundByConversation = new Map<string, Map<string, ConversationBinding>>();
  private readonly byThread = new Map<string, ConversationBinding>();
  private readonly actorsByConversation = new Map<string, Set<string>>();

  conversations(): ConversationTarget[] {
    return [...this.targetsByConversation.values()];
  }

  actors(target: ConversationTarget): string[] {
    return [...(this.actorsByConversation.get(this.key(target)) ?? [])];
  }

  rememberActor(target: ConversationTarget, actorId: string): void {
    if (!actorId) {
      throw new Error("Actor ID 不能为空");
    }
    const key = this.key(target);
    this.targetsByConversation.set(key, target);
    const actors = this.actorsByConversation.get(key) ?? new Set<string>();
    actors.add(actorId);
    this.actorsByConversation.set(key, actors);
  }

  forgetActor(target: ConversationTarget, actorId: string): void {
    const key = this.key(target);
    const actors = this.actorsByConversation.get(key);
    actors?.delete(actorId);
    if (actors?.size === 0) {
      this.actorsByConversation.delete(key);
    }
  }

  retainActors(target: ConversationTarget, actorIds: ReadonlySet<string>): boolean {
    for (const actorId of this.actors(target)) {
      if (!actorIds.has(actorId)) {
        this.forgetActor(target, actorId);
      }
    }
    if (this.actors(target).length === 0) {
      let removed = this.unbind(target) !== undefined;
      for (const binding of this.backgrounds(target)) {
        this.removeThread(binding.threadId);
        removed = true;
      }
      return removed;
    }
    return false;
  }

  getWorkspace(target: ConversationTarget): string | undefined {
    return this.workspaceByConversation.get(this.key(target));
  }

  selectWorkspace(target: ConversationTarget, workspaceId: string): void {
    const key = this.key(target);
    const binding = this.byConversation.get(key);
    if (binding && binding.workspaceId !== workspaceId) {
      throw new Error("切换 Workspace 前必须先解除当前 Thread 绑定");
    }
    this.targetsByConversation.set(key, target);
    this.workspaceByConversation.set(key, workspaceId);
  }

  get(target: ConversationTarget): ConversationBinding | undefined {
    return this.byConversation.get(this.key(target));
  }

  backgrounds(target: ConversationTarget): ConversationBinding[] {
    return [...(this.backgroundByConversation.get(this.key(target))?.values() ?? [])];
  }

  isBackground(threadId: string): boolean {
    const binding = this.byThread.get(threadId);
    return binding !== undefined
      && this.backgroundByConversation.get(this.key(binding.target))?.has(threadId) === true;
  }

  getByThread(threadId: string): ConversationBinding | undefined {
    return this.byThread.get(threadId);
  }

  list(): ConversationBinding[] {
    return [
      ...this.byConversation.values(),
      ...[...this.backgroundByConversation.values()].flatMap((bindings) => [...bindings.values()]),
    ];
  }

  bind(binding: ConversationBinding): void {
    this.switchForeground(binding, false);
  }

  bindBackground(binding: ConversationBinding): void {
    const conversationKey = this.key(binding.target);
    this.targetsByConversation.set(conversationKey, binding.target);
    const owner = this.byThread.get(binding.threadId);
    if (owner && this.key(owner.target) !== conversationKey) {
      throw new Error("该 Codex Thread 已绑定到其他会话");
    }
    if (this.byConversation.get(conversationKey)?.threadId === binding.threadId) {
      this.byConversation.delete(conversationKey);
    }
    const backgrounds = this.backgroundByConversation.get(conversationKey)
      ?? new Map<string, ConversationBinding>();
    backgrounds.set(binding.threadId, binding);
    this.backgroundByConversation.set(conversationKey, backgrounds);
    this.byThread.set(binding.threadId, binding);
  }

  switchForeground(
    binding: ConversationBinding,
    preserveCurrent: boolean,
  ): BindingSwitch {
    const conversationKey = this.key(binding.target);
    this.targetsByConversation.set(conversationKey, binding.target);
    const owner = this.byThread.get(binding.threadId);
    if (owner && this.key(owner.target) !== conversationKey) {
      throw new Error("该 Codex Thread 已绑定到其他会话");
    }
    const previous = this.byConversation.get(conversationKey);
    if (previous && previous.threadId !== binding.threadId) {
      if (preserveCurrent) {
        const backgrounds = this.backgroundByConversation.get(conversationKey)
          ?? new Map<string, ConversationBinding>();
        backgrounds.set(previous.threadId, previous);
        this.backgroundByConversation.set(conversationKey, backgrounds);
      } else {
        this.byThread.delete(previous.threadId);
      }
    }
    this.backgroundByConversation.get(conversationKey)?.delete(binding.threadId);
    this.byConversation.set(conversationKey, binding);
    this.byThread.set(binding.threadId, binding);
    this.workspaceByConversation.set(conversationKey, binding.workspaceId);
    return {
      binding,
      ...(preserveCurrent && previous && previous.threadId !== binding.threadId
        ? { backgrounded: previous }
        : {}),
      ...(!preserveCurrent && previous && previous.threadId !== binding.threadId
        ? { replaced: previous }
        : {}),
    };
  }

  demote(target: ConversationTarget): ConversationBinding | undefined {
    const key = this.key(target);
    const binding = this.byConversation.get(key);
    if (!binding) return undefined;
    this.byConversation.delete(key);
    const backgrounds = this.backgroundByConversation.get(key)
      ?? new Map<string, ConversationBinding>();
    backgrounds.set(binding.threadId, binding);
    this.backgroundByConversation.set(key, backgrounds);
    return binding;
  }

  removeThread(threadId: string): ConversationBinding | undefined {
    const binding = this.byThread.get(threadId);
    if (!binding) return undefined;
    const key = this.key(binding.target);
    if (this.byConversation.get(key)?.threadId === threadId) {
      this.byConversation.delete(key);
    }
    const backgrounds = this.backgroundByConversation.get(key);
    backgrounds?.delete(threadId);
    if (backgrounds?.size === 0) this.backgroundByConversation.delete(key);
    this.byThread.delete(threadId);
    return binding;
  }

  transfer(threadId: string, target: ConversationTarget): BindingTransfer {
    const previousOwner = this.byThread.get(threadId);
    if (!previousOwner) {
      throw new Error("待转移的 Codex Thread 当前没有外部会话绑定");
    }
    if (this.isBackground(threadId)) {
      throw new Error("运行中的后台 Thread 不能跨渠道接管");
    }
    const targetKey = this.key(target);
    const ownerKey = this.key(previousOwner.target);
    if (targetKey === ownerKey) {
      return { binding: previousOwner, previousOwner };
    }
    const replaced = this.byConversation.get(targetKey);
    const binding = {
      target,
      workspaceId: previousOwner.workspaceId,
      threadId: previousOwner.threadId,
      sessionId: previousOwner.sessionId,
    };
    this.unbind(previousOwner.target);
    if (replaced) {
      this.unbind(replaced.target);
    }
    this.bind(binding);
    return {
      binding,
      previousOwner,
      ...(replaced ? { replaced } : {}),
    };
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
    return conversationTargetKey(target);
  }
}
