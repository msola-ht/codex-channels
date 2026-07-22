interface TypingState {
  activityKeys: Set<string>;
  timer: NodeJS.Timeout;
}

export class TelegramTypingIndicator {
  private readonly states = new Map<string, TypingState>();
  private readonly lastSentAt = new Map<string, number>();
  private nextActivityId = 1;
  private closed = false;

  constructor(private readonly sendTyping: (chatId: string) => void) {}

  show(chatId: string): void {
    if (this.closed) {
      return;
    }
    const now = Date.now();
    if (now - (this.lastSentAt.get(chatId) ?? 0) < 1_000) {
      return;
    }
    this.lastSentAt.set(chatId, now);
    this.sendTyping(chatId);
  }

  begin(chatId: string): () => void {
    if (this.closed) {
      return () => undefined;
    }
    const activityKey = `request:${this.nextActivityId++}`;
    this.start(chatId, activityKey);
    return () => this.stop(chatId, activityKey);
  }

  start(chatId: string, activityKey: string): void {
    if (this.closed) {
      return;
    }
    const current = this.states.get(chatId);
    if (current) {
      current.activityKeys.add(activityKey);
      return;
    }
    const timer = setTimeout(() => this.refresh(chatId), 400);
    timer.unref();
    this.states.set(chatId, { activityKeys: new Set([activityKey]), timer });
  }

  stop(chatId: string, activityKey: string): void {
    const state = this.states.get(chatId);
    if (!state) {
      return;
    }
    state.activityKeys.delete(activityKey);
    if (state.activityKeys.size === 0) {
      clearTimeout(state.timer);
      this.states.delete(chatId);
    }
  }

  clear(chatId: string): void {
    const state = this.states.get(chatId);
    if (state) {
      clearTimeout(state.timer);
      this.states.delete(chatId);
    }
  }

  close(): void {
    this.closed = true;
    for (const state of this.states.values()) {
      clearTimeout(state.timer);
    }
    this.states.clear();
    this.lastSentAt.clear();
  }

  private refresh(chatId: string): void {
    const state = this.states.get(chatId);
    if (!state || state.activityKeys.size === 0 || this.closed) {
      return;
    }
    this.show(chatId);
    const timer = setTimeout(() => this.refresh(chatId), 4_000);
    timer.unref();
    state.timer = timer;
  }
}
