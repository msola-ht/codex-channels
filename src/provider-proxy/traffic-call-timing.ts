/** 单次调用的单调时钟节点；只写调用记录，不进入指标 IPC。 */
export class TrafficCallTiming {
  private forwardingMs?: number;
  private requestBodyEndMs?: number;
  private responseHeadMs?: number;
  private submittedMs?: number;
  private connectionReady: boolean | undefined;

  constructor(private readonly startedAt: number) {}

  forwarding(at: number, connectionReady?: boolean): void {
    this.forwardingMs = at - this.startedAt;
    this.connectionReady = connectionReady;
  }

  requestBodyEnd(at: number): void { this.requestBodyEndMs = at - this.startedAt; }
  responseHead(at: number): void { this.responseHeadMs = at - this.startedAt; }
  submitted(at: number): void { this.submittedMs = at - this.startedAt; }

  finish(at: number, firstContentMs: number | undefined, totalDurationMs?: number) {
    const sentMs = this.submittedMs ?? this.forwardingMs;
    return {
      clock: "monotonic" as const,
      endMs: sentMs !== undefined && totalDurationMs !== undefined ? sentMs + totalDurationMs : at - this.startedAt,
      ...(this.forwardingMs === undefined ? {} : { forwardingMs: this.forwardingMs }),
      ...(this.requestBodyEndMs === undefined ? {} : { requestBodyEndMs: this.requestBodyEndMs }),
      ...(this.responseHeadMs === undefined ? {} : { responseHeadMs: this.responseHeadMs }),
      ...(this.submittedMs === undefined ? {} : { submittedMs: this.submittedMs }),
      ...(this.connectionReady === undefined ? {} : { connectionReady: this.connectionReady }),
      ...(sentMs === undefined || firstContentMs === undefined ? {} : {
        firstEventMs: sentMs + firstContentMs,
      }),
    };
  }
}
