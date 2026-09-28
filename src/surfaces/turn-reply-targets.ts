export class TurnReplyTargets<T> {
  private readonly pending = new Map<string, T[]>();
  private readonly byTurn = new Map<string, { conversationId: string; target: T }>();

  prepare(conversationId: string, target: T): void {
    const current = this.pending.get(conversationId) ?? [];
    current.push(target);
    this.pending.set(conversationId, current);
  }

  bindPending(
    conversationId: string,
    turnKey: string,
  ): T | undefined {
    const pending = this.pending.get(conversationId);
    if (pending === undefined || pending.length === 0) {
      return this.get(conversationId, turnKey);
    }
    this.pending.delete(conversationId);
    const target = pending[0]!;
    this.set(conversationId, turnKey, target);
    return target;
  }

  discardPending(conversationId: string): void {
    this.pending.delete(conversationId);
  }

  set(conversationId: string, turnKey: string, target: T): void {
    this.byTurn.set(turnKey, { conversationId, target });
  }

  get(conversationId: string, turnKey: string): T | undefined {
    const entry = this.byTurn.get(turnKey);
    return entry?.conversationId === conversationId ? entry.target : undefined;
  }

  delete(conversationId: string, turnKey: string): void {
    if (this.byTurn.get(turnKey)?.conversationId === conversationId) this.byTurn.delete(turnKey);
  }

  clearThread(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.byTurn.keys()) {
      if (key.startsWith(prefix)) {
        this.byTurn.delete(key);
      }
    }
  }

  clear(): void {
    this.pending.clear();
    this.byTurn.clear();
  }
}
