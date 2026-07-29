import type {
  InteractionDecision,
  InteractionRequest,
} from "../approval/index.js";

export interface PendingInteractionRecord {
  requestId: string;
  request: InteractionRequest;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
}

interface ResolvedPendingInteraction<T> {
  token: string;
  pending?: T;
}

export type PendingInteractionActivation =
  | "active"
  | "missing"
  | "resolved-before-active";

export class PendingInteractionRegistry<
  T extends PendingInteractionRecord,
> {
  private readonly pendingByToken = new Map<string, T>();
  private readonly tokenByRequest = new Map<string, string>();
  private readonly resolvedBeforePending = new Set<string>();

  constructor(private readonly capacity = 100) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("Surface 待处理交互容量必须是正整数");
    }
  }

  reserve(requestId: string, token: string): boolean {
    if (
      this.tokenByRequest.has(requestId)
      || this.tokenByRequest.size >= this.capacity
      || [...this.tokenByRequest.values()].includes(token)
    ) {
      return false;
    }
    this.tokenByRequest.set(requestId, token);
    return true;
  }

  release(requestId: string, token: string): void {
    if (this.tokenByRequest.get(requestId) === token) {
      this.tokenByRequest.delete(requestId);
    }
    this.resolvedBeforePending.delete(token);
  }

  activate(token: string, pending: T): PendingInteractionActivation {
    if (this.tokenByRequest.get(pending.requestId) !== token) {
      return "missing";
    }
    this.pendingByToken.set(token, pending);
    return this.resolvedBeforePending.delete(token)
      ? "resolved-before-active"
      : "active";
  }

  get(token: string): T | undefined {
    return this.pendingByToken.get(token);
  }

  resolved(requestId: string): ResolvedPendingInteraction<T> | undefined {
    const token = this.tokenByRequest.get(requestId);
    if (token === undefined) {
      return undefined;
    }
    const pending = this.pendingByToken.get(token);
    if (pending === undefined) {
      this.resolvedBeforePending.add(token);
      return { token };
    }
    return { token, pending };
  }

  take(token: string): T | undefined {
    const pending = this.pendingByToken.get(token);
    if (pending === undefined) {
      return undefined;
    }
    this.pendingByToken.delete(token);
    if (this.tokenByRequest.get(pending.requestId) === token) {
      this.tokenByRequest.delete(pending.requestId);
    }
    this.resolvedBeforePending.delete(token);
    clearTimeout(pending.timer);
    return pending;
  }

  entries(): Array<[string, T]> {
    return [...this.pendingByToken.entries()];
  }

  newest(
    predicate: (pending: T) => boolean,
  ): [string, T] | undefined {
    return this.entries().reverse().find(([, pending]) => predicate(pending));
  }

  clearPreparingResolutions(): void {
    this.resolvedBeforePending.clear();
  }
}
