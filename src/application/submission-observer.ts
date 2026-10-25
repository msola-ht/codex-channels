import type { Submission } from "./conversation-service.js";

export type SubmissionPreparation = Readonly<{ threadId: string } & (
  | { kind: "review" }
  | { kind: "start-or-steer"; clientUserMessageId: string }
  | { kind: "steer"; clientUserMessageId: string; expectedTurnId: string }
)>;

export type SubmissionOutcome = "not-submitted" | "confirmed" | "unknown";

/** Local synchronous bookkeeping only; never serialized or used as origin proof. */
export interface SubmissionObserver {
  prepared: (value: SubmissionPreparation) => undefined;
  requestAttempted: () => undefined;
  confirmed: (value: Readonly<Submission>) => undefined;
  settled: (value: Readonly<{ outcome: SubmissionOutcome }>) => undefined;
}

/** One submit call, including validation, lock waiting and client preparation. */
export class SubmissionObservation {
  private preparation: SubmissionPreparation | undefined;
  private outcome: SubmissionOutcome = "not-submitted";
  private finished = false;

  constructor(private readonly observer: SubmissionObserver) {}

  prepare(value: SubmissionPreparation): void {
    if (this.preparation || this.finished) throw new Error("提交观察已准备或结束");
    const prepared = Object.freeze({ ...value });
    this.preparation = prepared;
    this.invoke(() => this.observer.prepared(prepared));
  }

  attempt(): undefined {
    if (!this.preparation || this.finished || this.outcome !== "not-submitted") {
      throw new Error("提交观察的请求阶段无效");
    }
    // Conservative: observer failure here must never permit retrying the input.
    this.outcome = "unknown";
    this.invoke(() => this.observer.requestAttempted());
  }

  confirm(value: Submission): void {
    const prepared = this.preparation;
    if (!prepared || this.finished || this.outcome !== "unknown"
      || value.threadId !== prepared.threadId || !value.turnId.trim()
      || (prepared.kind === "steer" && value.turnId !== prepared.expectedTurnId)) {
      throw new Error("提交响应与准备身份不一致");
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
      throw new Error("提交观察必须同步返回 undefined");
    }
  }
}
