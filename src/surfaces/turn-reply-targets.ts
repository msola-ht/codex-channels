export class TurnReplyTargets<T> {
  private readonly pending = new Map<string, T[]>();
  private readonly byTurn = new Map<string, T>();

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
      return this.byTurn.get(turnKey);
    }
    this.pending.delete(conversationId);
    const target = pending[0]!;
    this.byTurn.set(turnKey, target);
    return target;
  }

  discardPending(conversationId: string): void {
    this.pending.delete(conversationId);
  }

  set(turnKey: string, target: T): void {
    this.byTurn.set(turnKey, target);
  }

  get(turnKey: string): T | undefined {
    return this.byTurn.get(turnKey);
  }

  delete(turnKey: string): void {
    this.byTurn.delete(turnKey);
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
