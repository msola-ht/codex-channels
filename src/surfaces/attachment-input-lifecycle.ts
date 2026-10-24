import type { PreparedAttachmentSubmission } from "../application/index.js";
import { conversationTargetKey, UserFacingError, type ConversationTarget } from "../conversation-core/index.js";

export interface ReceivedAttachmentInput {
  prepare(): Promise<PreparedAttachmentSubmission>;
  dispose(): void;
}

interface PendingStop {
  completed: boolean;
  waiters: Set<() => void>;
}

/** Owns only accepted, unfinished Surface inputs, including their queue wait. */
export class AttachmentInputLifecycle {
  private readonly pending = new Map<string, Set<AbortController>>();
  private readonly stops = new Map<string, Set<PendingStop>>();
  private closed = false;

  receive(
    target: ConversationTarget,
    allowed: () => boolean,
    kind: "audio" | "video",
    create: () => PreparedAttachmentSubmission | undefined,
  ): ReceivedAttachmentInput {
    const key = conversationTargetKey(target);
    const pending = this.pending.get(key) ?? new Set<AbortController>();
    const unavailable = () => new UserFacingError(`${kind}.unavailable`, "附件输入已取消、超时、未获授权或正在处理过多附件，请重新发送");
    if (this.closed || !allowed() || pending.size >= 4 || (!this.pending.has(key) && this.pending.size >= 1000)) {
      return { dispose: () => undefined, prepare: () => Promise.reject(unavailable()) };
    }
    const controller = new AbortController();
    const stops = [...this.stops.get(key) ?? []];
    pending.add(controller);
    this.pending.set(key, pending);
    let scope: PreparedAttachmentSubmission | undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      pending.delete(controller);
      if (pending.size === 0 && this.pending.get(key) === pending) this.pending.delete(key);
      controller.abort();
      scope?.dispose();
    };
    const timer = setTimeout(dispose, 120_000);
    timer.unref();
    controller.signal.addEventListener("abort", dispose, { once: true });
    return {
      dispose,
      prepare: async () => {
        if (stops.some(stop => !stop.completed) && !controller.signal.aborted) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              if (!controller.signal.aborted && stops.some(stop => !stop.completed)) return;
              controller.signal.removeEventListener("abort", finish);
              for (const stop of stops) stop.waiters.delete(finish);
              resolve();
            };
            controller.signal.addEventListener("abort", finish, { once: true });
            for (const stop of stops) if (!stop.completed) stop.waiters.add(finish);
          });
        }
        if (controller.signal.aborted || !allowed()) throw unavailable();
        scope ??= create();
        if (!scope) throw unavailable();
        return scope;
      },
    };
  }

  /** Called synchronously at authorized stop reception; completion releases newer input. */
  receiveStop(target: ConversationTarget): (() => void) & { cancelled: boolean } {
    const key = conversationTargetKey(target);
    const cancelled = (this.pending.get(key)?.size ?? 0) > 0;
    for (const controller of [...this.pending.get(key) ?? []]) controller.abort();
    const stops = this.stops.get(key) ?? new Set<PendingStop>();
    const stop: PendingStop = { completed: false, waiters: new Set() };
    stops.add(stop);
    this.stops.set(key, stops);
    return Object.assign(() => {
      stop.completed = true;
      stops.delete(stop);
      if (stops.size === 0 && this.stops.get(key) === stops) this.stops.delete(key);
      for (const notify of [...stop.waiters]) notify();
    }, { cancelled });
  }

  close(): void {
    this.closed = true;
    for (const pending of [...this.pending.values()]) {
      for (const controller of [...pending]) controller.abort();
    }
    this.stops.clear();
  }
}
