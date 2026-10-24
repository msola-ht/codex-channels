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
  private closeTask: Promise<void> | undefined;
  constructor(private readonly options: {
    path: string;
    writer: ModelRequestMetricsWriter;
    authorize: ((sample: RelayMetric, signal: AbortSignal) => RelayMetricRejection | undefined | Promise<RelayMetricRejection | undefined>) & { prepare(): Promise<void>; close(): Promise<void> };
  }) {}

  apply(enabled: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.task && enabled && this.server && !this.serverReady) return Promise.reject(new Error("Relay 指标接收器的上次清理尚未确认"));
    this.desired = enabled;
    if (!this.task) {
      this.task = this.reconcile().finally(() => { this.task = undefined; });
    }
    return this.task.then(() => {
      // An apply may arrive after reconcile settles but before its finally runs.
      if (!this.closed && Boolean(this.server) !== this.desired) return this.apply(this.desired);
    });
  }
  close(): Promise<void> {
    this.closed = true; this.desired = false;
    this.serverReady = false;
    if (this.closeTask) return this.closeTask;
    const failures: unknown[] = [];
    // Cancel the owned reader before waiting for startup, including Worker/ACL initialization.
    const authorizationClose = Promise.resolve().then(() => this.options.authorize.close()).catch(error => { failures.push(error); });
    this.closeTask = (async () => {
      try { await this.task; } catch (error) { failures.push(error); }
      try { await this.server?.close(); this.server = undefined; } catch (error) { failures.push(error); }
      await authorizationClose;
      if (failures.length > 0) throw new AggregateError(failures, "Relay 指标组件未完全关闭");
    })().finally(() => { this.closeTask = undefined; });
    return this.closeTask;
  }
  private async reconcile(): Promise<void> {
    while (!this.closed && Boolean(this.server) !== this.desired) {
      if (!this.desired) { this.serverReady = false; await this.server?.close(); this.server = undefined; }
      else {
        try { await this.options.authorize.prepare(); }
        catch (error) { if (this.closed) return; throw error; }
        if (this.closed || !this.desired) continue;
        const server = new RelayMetricsServer(this.options.path, (sample, signal) => this.receive(sample, signal));
        this.server = server;
        try {
          await server.start();
          // Stop or a newer apply may arrive while the private listener is starting.
          if (this.closed || !this.desired) {
            await server.close(); this.server = undefined;
            continue;
          }
          this.serverReady = true;
        } catch (error) {
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
