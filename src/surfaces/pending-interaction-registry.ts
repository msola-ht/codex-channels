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

export async function waitForInteractionPreparation<T>(
  signal: AbortSignal,
  preparation: Promise<T>,
): Promise<T | undefined> {
  let cancel!: () => void;
  const cancelled = new Promise<undefined>((resolve) => { cancel = () => resolve(undefined); });
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await Promise.race([preparation, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

interface ResolvedPendingInteraction<T> {
  token: string;
  pending?: T;
}

export type PendingInteractionActivation =
  | "active"
  | "missing";

export class PendingInteractionRegistry<
  T extends PendingInteractionRecord,
> {
  private readonly pendingByToken = new Map<string, T>();
  private readonly tokenByRequest = new Map<string, string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly preparationCleanup = new Map<string, () => void>();

  constructor(private readonly capacity = 100) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("Surface 待处理交互容量必须是正整数");
    }
  }

  reserve(requestId: string, token: string, onPreparationCancelled?: () => void): boolean {
    if (
      this.tokenByRequest.has(requestId)
      || this.tokenByRequest.size >= this.capacity
      || [...this.tokenByRequest.values()].includes(token)
    ) {
      return false;
    }
    this.tokenByRequest.set(requestId, token);
    this.controllers.set(token, new AbortController());
    if (onPreparationCancelled) this.preparationCleanup.set(token, onPreparationCancelled);
    return true;
  }

  signal(token: string): AbortSignal {
    const controller = this.controllers.get(token);
    if (!controller) throw new Error("交互请求已失效");
    return controller.signal;
  }

  release(requestId: string, token: string, outcome = "请求已失效"): void {
    if (this.tokenByRequest.get(requestId) === token) {
      this.tokenByRequest.delete(requestId);
    }
    const controller = this.controllers.get(token);
    this.controllers.delete(token);
    controller?.abort(new Error(outcome));
    const cleanup = this.preparationCleanup.get(token);
    this.preparationCleanup.delete(token);
    cleanup?.();
  }

  activate(token: string, pending: T): PendingInteractionActivation {
    if (this.tokenByRequest.get(pending.requestId) !== token) {
      return "missing";
    }
    this.pendingByToken.set(token, pending);
    this.preparationCleanup.delete(token);
    return "active";
  }

  get(token: string): T | undefined {
    return this.pendingByToken.get(token);
  }

  resolved(requestId: string, outcome = "请求已失效"): ResolvedPendingInteraction<T> | undefined {
    const token = this.tokenByRequest.get(requestId);
    if (token === undefined) {
      return undefined;
    }
    const pending = this.pendingByToken.get(token);
    if (pending === undefined) {
      this.release(requestId, token, outcome);
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
    clearTimeout(pending.timer);
    this.release(pending.requestId, token);
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

  cancelPreparing(outcome = "请求已失效"): void {
    for (const [requestId, token] of this.tokenByRequest) {
      if (!this.pendingByToken.has(token)) this.release(requestId, token, outcome);
    }
  }
}
