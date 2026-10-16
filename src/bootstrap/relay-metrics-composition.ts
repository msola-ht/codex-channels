import { RelayMetricsServer, type RelayMetric, type RelayMetricRejection } from "../provider-proxy/index.js";
import type { ModelRequestMetricsWriter } from "../observability/index.js";
export { createRelayMetricAuthorization } from "../../runtime/model-relay-metrics-authorization.mjs";

/** Gateway-only receiver. Never sends Core events or owns the database writer lifecycle. */
export class RelayMetricsComposition {
  private server: RelayMetricsServer | undefined;
  private serverReady = false;
  private desired = false;
  private closed = false;
  private task: Promise<void> | undefined;
  constructor(private readonly options: {
    path: string;
    writer: ModelRequestMetricsWriter;
    authorize: ((sample: RelayMetric, signal: AbortSignal) => RelayMetricRejection | undefined | Promise<RelayMetricRejection | undefined>) & { close?(): Promise<void> };
  }) {}

  apply(enabled: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.task && enabled && this.server && !this.serverReady) return Promise.reject(new Error("Relay 指标接收器的上次清理尚未确认"));
    this.desired = enabled;
    if (!this.task) {
      this.task = this.reconcile().finally(() => { this.task = undefined; });
    }
    return this.task;
  }
  async close(): Promise<void> {
    this.closed = true; this.desired = false;
    const failures: unknown[] = [];
    try { await this.task; } catch (error) { failures.push(error); }
    this.serverReady = false;
    try { await this.server?.close(); this.server = undefined; } catch (error) { failures.push(error); }
    try { await this.options.authorize.close?.(); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "Relay 指标组件未完全关闭");
  }
  private async reconcile(): Promise<void> {
    while (Boolean(this.server) !== this.desired) {
      if (!this.desired) { this.serverReady = false; await this.server?.close(); this.server = undefined; }
      else {
        const server = new RelayMetricsServer(this.options.path, (sample, signal) => this.receive(sample, signal));
        this.server = server;
        try { await server.start(); this.serverReady = true; } catch (error) {
          await server.close();
          this.server = undefined;
          throw error;
        }
      }
    }
  }
  private async receive(sample: RelayMetric, signal: AbortSignal): Promise<RelayMetricRejection | undefined> {
    if (this.closed || !this.desired || !this.serverReady || signal.aborted) return "closing";
    const rejection = await this.options.authorize(sample, signal);
    if (this.closed || !this.desired || !this.serverReady || signal.aborted) return "closing";
    if (rejection) return rejection;
    this.options.writer.enqueue({
      ...sample, transport: "http", operation: "response", model: sample.responseModel ?? sample.requestModel,
      serviceTier: null, requestServiceTier: null, reasoningEffort: sample.reasoningEffort ?? null, httpStatus: sample.httpStatus ?? null,
      errorType: sample.errorCode ?? null, errorCode: sample.errorCode ?? null, errorMessage: null, incompleteReason: null,
      inputTokens: sample.inputTokens ?? null, cachedInputTokens: sample.cachedInputTokens ?? null,
      outputTokens: sample.outputTokens ?? null, reasoningOutputTokens: sample.reasoningOutputTokens ?? null,
      totalTokens: sample.totalTokens ?? null, weeklyQuota: null,
    });
    return undefined;
  }
}
