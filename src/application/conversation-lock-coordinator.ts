import {
  conversationTargetKey,
  type ConversationTarget,
} from "../conversation-core/index.js";

export class ConversationLockCoordinator {
  private readonly locks = new Map<string, Promise<void>>();

  forConversation<T>(
    target: ConversationTarget,
    action: () => Promise<T> | T,
  ): Promise<T> {
    return this.forKey(conversationTargetKey(target), action);
  }

  forConversations<T>(
    targets: readonly ConversationTarget[],
    action: () => Promise<T> | T,
  ): Promise<T> {
    const keys = [...new Set(targets.map(conversationTargetKey))].sort();
    const acquire = (index: number): Promise<T> => {
      const key = keys[index];
      return key === undefined
        ? Promise.resolve(action())
        : this.forKey(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private async forKey<T>(
    key: string,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.locks.set(key, chain);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.locks.get(key) === chain) {
        this.locks.delete(key);
      }
    }
  }
}
