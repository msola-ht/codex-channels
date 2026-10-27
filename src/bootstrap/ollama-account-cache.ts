import { AccountQueryError } from "./account-query.js";

export interface CachedAccountValue<T> { value: T; observedAtMs: number; stale: boolean }
export interface OllamaAccountRateLimit { retryAt: number; failure?: AccountQueryError }

/** One entry per fixed endpoint/range, owned by an exact account adapter. */
export class OllamaAccountCache<T> {
  private snapshot: CachedAccountValue<T> | undefined;
  private retryAt = 0;
  private failure?: unknown;
  private pending: { controller: AbortController; promise: Promise<CachedAccountValue<T>>; consumers: Set<() => void> } | undefined;

  constructor(private readonly rateLimit?: OllamaAccountRateLimit, private readonly ttlMs = 30_000) {}

  clear(): void {
    this.pending?.controller.abort();
    this.pending = undefined;
    this.snapshot = undefined;
    this.failure = undefined;
    this.retryAt = 0;
  }

  async read(load: (signal: AbortSignal, assertCurrent: () => void) => Promise<T>, refresh: boolean,
    signal?: AbortSignal, beforeSubmit?: () => void): Promise<CachedAccountValue<T>> {
    signal?.throwIfAborted();
    beforeSubmit?.();
    const now = Date.now();
    const blocked = this.rateLimit && now < this.rateLimit.retryAt
      ? this.rateLimit : { retryAt: this.retryAt, failure: this.failure };
    if (now < blocked.retryAt) {
      if (this.snapshot && now - this.snapshot.observedAtMs < 300_000) return { ...this.snapshot, stale: true };
      throw blocked.failure;
    }
    if (this.snapshot && now - this.snapshot.observedAtMs < (refresh ? 3_000 : this.ttlMs)) return this.snapshot;
    if (!this.pending) {
      const controller = new AbortController();
      const consumers = new Set<() => void>();
      const assertCurrent = (): void => {
        controller.signal.throwIfAborted();
        let failure: unknown = new Error("账户查询已无有效等待者");
        for (const authorize of consumers) {
          try { authorize(); return; } catch (error) { failure = error; }
        }
        // One invalid caller must neither cancel other authorized consumers nor
        // turn a conversation change into an account-wide failure/backoff.
        controller.abort(failure);
        controller.signal.throwIfAborted();
      };
      const pending = { controller, consumers, promise: Promise.resolve().then(async () => {
        try {
          assertCurrent();
          const value = await load(controller.signal, assertCurrent);
          assertCurrent();
          controller.signal.throwIfAborted();
          this.snapshot = { value, observedAtMs: Date.now(), stale: false };
          this.failure = undefined;
          this.retryAt = 0;
          return this.snapshot;
        } catch (error) {
          controller.signal.throwIfAborted();
          this.failure = error;
          this.retryAt = Date.now() + Math.max(30_000, error instanceof AccountQueryError ? error.diagnostic.retryAfterMs ?? 0 : 0);
          if (this.rateLimit && error instanceof AccountQueryError && error.diagnostic.reason === "rate-limited") {
            this.rateLimit.retryAt = Math.max(this.rateLimit.retryAt, this.retryAt);
            this.rateLimit.failure = error;
          }
          if (error instanceof AccountQueryError && error.diagnostic.reason === "authentication") this.snapshot = undefined;
          if (this.snapshot && Date.now() - this.snapshot.observedAtMs < 300_000) return { ...this.snapshot, stale: true };
          throw error;
        }
      }) };
      this.pending = pending;
      const clear = (): void => { if (this.pending === pending) this.pending = undefined; };
      void pending.promise.then(clear, clear);
    }
    const shared = this.pending;
    const authorize = (): void => { signal?.throwIfAborted(); beforeSubmit?.(); };
    shared.consumers.add(authorize);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value?: CachedAccountValue<T>, error?: unknown): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        shared.consumers.delete(authorize);
        if (shared.consumers.size === 0) {
          if (this.pending === shared) this.pending = undefined;
          shared.controller.abort();
        }
        if (value) resolve(value); else reject(error instanceof Error ? error : new Error("账户查询取消或失败", { cause: error }));
      };
      const cancel = (): void => finish(undefined, signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      void shared.promise.then(value => {
        try { authorize(); finish(value); } catch (error) { finish(undefined, error); }
      }, error => finish(undefined, error));
      if (signal?.aborted) cancel();
    });
  }
}
