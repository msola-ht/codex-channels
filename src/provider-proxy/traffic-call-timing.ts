/** 调用转储复用指标的发送起点；没有提交发送的调用不伪造耗时。 */
export class TrafficCallTiming {
  private submittedAt?: number;

  submitted(at: number): void { this.submittedAt ??= at; }

  finish(at: number, firstTokenMs: number | undefined, totalDurationMs?: number) {
    if (this.submittedAt === undefined) return undefined;
    return {
      clock: "monotonic" as const,
      basis: "submitted" as const,
      endMs: totalDurationMs ?? at - this.submittedAt,
      ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    };
  }
}
