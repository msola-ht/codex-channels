export type QueuePreparation = Readonly<
  | { kind: "add"; threadId: string; clientUserMessageId: string }
  | { kind: "start"; threadId: string; queuedSubmissionId: string; clientUserMessageId: string }
>;

export type QueueSubmissionConfirmation = Readonly<
  | { kind: "add"; threadId: string; queuedSubmissionId: string; clientUserMessageId: string }
  | { kind: "start"; threadId: string; turnId: string }
>;

export type QueueSubmissionOutcome = "not-submitted" | "confirmed" | "unknown";

/** Local synchronous bookkeeping only; Queue acceptance never proves a Turn. */
export interface ThreadQueueSubmissionObserver {
  prepared: (value: QueuePreparation) => undefined;
  requestAttempted: () => undefined;
  confirmed: (value: QueueSubmissionConfirmation) => undefined;
  settled: (value: Readonly<{ outcome: QueueSubmissionOutcome }>) => undefined;
}

export interface ThreadQueueExecutionContext {
  submission?: ThreadQueueSubmissionObserver;
  deleted?: (value: Readonly<{ threadId: string; queuedSubmissionId: string }>) => undefined;
}

/** One Queue add/start request; the command owner settles every exit path. */
export class QueueSubmissionObservation {
  private preparation: QueuePreparation | undefined;
  private outcome: QueueSubmissionOutcome = "not-submitted";
  private finished = false;

  constructor(private readonly observer: ThreadQueueSubmissionObserver) {}

  prepare(value: QueuePreparation): void {
    if (this.preparation || this.finished || !nonEmptyString(value.threadId)
      || !nonEmptyString(value.clientUserMessageId)
      || (value.kind !== "add" && value.kind !== "start")
      || (value.kind === "start" && !nonEmptyString(value.queuedSubmissionId))) {
      throw new Error("Queue 提交观察的准备身份无效");
    }
    const prepared = Object.freeze({ ...value });
    this.preparation = prepared;
    this.invoke(() => this.observer.prepared(prepared));
  }

  attempt(): undefined {
    if (!this.preparation || this.finished || this.outcome !== "not-submitted") {
      throw new Error("Queue 提交观察的请求阶段无效");
    }
    // A failing observer at the final write boundary must never allow replay.
    this.outcome = "unknown";
    this.invoke(() => this.observer.requestAttempted());
  }

  confirm(value: QueueSubmissionConfirmation): void {
    const prepared = this.preparation;
    if (!prepared || this.finished || this.outcome !== "unknown"
      || value.threadId !== prepared.threadId || value.kind !== prepared.kind) {
      throw new Error("Queue 提交响应与准备身份不一致");
    }
    if (prepared.kind === "add") {
      if (value.kind !== "add" || "turnId" in value
        || !nonEmptyString(value.queuedSubmissionId)
        || value.clientUserMessageId !== prepared.clientUserMessageId) {
        throw new Error("Queue 新增响应与准备身份不一致");
      }
    } else if (value.kind !== "start" || "queuedSubmissionId" in value
      || !nonEmptyString(value.turnId)) {
      throw new Error("Queue 启动响应缺少有效 Turn 身份");
    }
    this.invoke(() => this.observer.confirmed(Object.freeze({ ...value })));
    this.outcome = "confirmed";
  }

  settle(): void {
    if (this.finished) return;
    this.finished = true;
    this.invoke(() => this.observer.settled(Object.freeze({ outcome: this.outcome })));
  }

  private invoke(callback: () => undefined): void {
    const result: unknown = callback();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new Error("Queue 提交观察必须同步返回 undefined");
    }
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
