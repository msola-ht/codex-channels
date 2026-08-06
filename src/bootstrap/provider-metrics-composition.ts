import type { Logger } from "pino";

import type { ConversationInputEvent } from "../conversation-core/index.js";
import type {
  ModelPricingResolver,
  ModelRequestPricingSnapshot,
  ModelRequestMetricsWriter,
} from "../observability/index.js";
import { calculateModelRequestCostComponents } from "../observability/index.js";
import type { ThreadModelSettings } from "../session-routing/index.js";
import {
  ProviderProxyMetricsServer,
  type ProviderProxyMetrics,
} from "../provider-proxy/index.js";

type ModelTimingEvent = Extract<
  ConversationInputEvent,
  { type: "turn.modelTiming.updated" }
>;

export interface ProviderMetricsCompositionOptions {
  providers: readonly string[];
  socketPath: (provider: string) => string;
  writer: ModelRequestMetricsWriter;
  pricingResolver?: ModelPricingResolver;
  resolveModelSettings?: (threadId: string) => ThreadModelSettings | undefined;
  onModelTiming: (event: ModelTimingEvent) => void;
  logger: Logger;
}

export class ProviderMetricsComposition {
  private readonly servers: ProviderProxyMetricsServer[];

  constructor(private readonly options: ProviderMetricsCompositionOptions) {
    this.servers = [...new Set(options.providers)].map((provider) =>
      new ProviderProxyMetricsServer(
        options.socketPath(provider),
        (metrics) => this.handle(provider, metrics),
        (error) => {
          options.logger.warn({ err: error, provider }, "模型统计代理指标接收失败");
        },
      ));
  }

  async start(): Promise<void> {
    await Promise.all(this.servers.map((server) => server.start()));
    this.options.logger.info(
      { providerCount: this.servers.length },
      "模型统计代理指标接收已启动",
    );
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    await Promise.all(this.servers.map(async (server) => {
      try {
        await server.close();
      } catch (error) {
        failures.push(error);
      }
    }));
    try {
      await this.options.writer.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "模型请求指标组件未完全关闭");
    }
  }

  private handle(provider: string, metrics: ProviderProxyMetrics): void {
    let pricing: ModelRequestPricingSnapshot | null = null;
    try {
      pricing = this.options.pricingResolver?.resolve({
        provider,
        model: metrics.model,
        serviceTier: metrics.serviceTier,
        inputTokens: metrics.inputTokens,
        atMs: metrics.responseCompletedAtMs,
      }) ?? null;
      this.options.writer.enqueue({
        provider,
        ...metrics,
        pricing,
        reasoningEffort:
          metrics.threadId === null
            ? null
            : this.options.resolveModelSettings?.(metrics.threadId)?.effort ?? null,
      });
    } catch (error) {
      this.options.logger.warn({ err: error, provider }, "模型请求指标持久化失败");
    }
    const event = toModelTimingEvent(metrics, pricing);
    if (!event) {
      this.options.logger.debug(
        {
          provider,
          hasTurnMetadata: metrics.threadId !== null && metrics.turnId !== null,
          hasTokenWindow: metrics.firstTokenAtMs !== null,
        },
        "模型统计代理指标缺少 Turn 关联或 Token 窗口，未归约完成卡片计时",
      );
      return;
    }
    this.options.onModelTiming(event);
    this.options.logger.debug(
      {
        provider,
        ttftMs: event.ttftMs,
        ...(event.thinkingDurationMs === undefined
          ? {}
          : { thinkingDurationMs: event.thinkingDurationMs }),
        ...(event.outputDurationMs === undefined
          ? {}
          : { outputDurationMs: event.outputDurationMs }),
        ...(event.generationDurationMs === undefined
          ? {}
          : { generationDurationMs: event.generationDurationMs }),
      },
      "模型统计代理指标已关联到 Turn",
    );
  }
}

export function toModelTimingEvent(
  metrics: ProviderProxyMetrics,
  pricing: ModelRequestPricingSnapshot | null = null,
): ModelTimingEvent | undefined {
  const firstTokenAtMs = metrics.firstTokenAtMs;
  if (
    metrics.threadId === null
    || metrics.turnId === null
  ) {
    return undefined;
  }
  const costComponents = metrics.status === "completed"
    ? calculateModelRequestCostComponents(metrics, pricing)
    : null;
  const common = {
    type: "turn.modelTiming.updated" as const,
    threadId: metrics.threadId,
    turnId: metrics.turnId,
    operation: metrics.operation,
    ...(metrics.model === null ? {} : { model: metrics.model }),
    requestStartedAtMs: metrics.requestStartedAtMs,
    requestDurationMs: Math.max(
      0,
      metrics.responseCompletedAtMs - metrics.requestStartedAtMs,
    ),
    outcome: metrics.status === "completed"
      ? "completed" as const
      : metrics.errorType === "client_disconnected"
        ? "interrupted" as const
        : metrics.status === "incomplete" || metrics.status === "unknown"
          ? "incomplete" as const
          : "failed" as const,
    ...(isRetryableFailure(metrics) ? { retryableFailure: true } : {}),
    ...(metrics.inputTokens === null ? {} : { inputTokens: metrics.inputTokens }),
    ...(metrics.cachedInputTokens === null
      ? {}
      : { cachedInputTokens: metrics.cachedInputTokens }),
    ...(metrics.outputTokens === null ? {} : { outputTokens: metrics.outputTokens }),
    ...(metrics.reasoningOutputTokens === null
      ? {}
      : { reasoningOutputTokens: metrics.reasoningOutputTokens }),
    ...(pricing?.currency === null
      || pricing?.currency === undefined
      || costComponents === null
      ? {}
      : {
          pricingCurrency: pricing.currency,
          totalCostNanos: costComponents.totalCostNanos,
          uncachedInputCostNanos: costComponents.uncachedInputCostNanos,
          cachedInputCostNanos: costComponents.cachedInputCostNanos,
          outputCostNanos: costComponents.outputCostNanos,
          ...(pricing.uncachedInputPricePerMillionNanos === null
            ? {}
            : {
                uncachedInputPricePerMillionNanos:
                  pricing.uncachedInputPricePerMillionNanos,
              }),
          ...(pricing.cachedInputPricePerMillionNanos === null
            ? {}
            : {
                cachedInputPricePerMillionNanos:
                  pricing.cachedInputPricePerMillionNanos,
              }),
          ...(pricing.outputPricePerMillionNanos === null
            ? {}
            : {
                outputPricePerMillionNanos:
                  pricing.outputPricePerMillionNanos,
              }),
        }),
  };
  if (firstTokenAtMs === null) return common;
  const lastTokenAtMs = Math.max(
    metrics.lastReasoningDeltaAtMs ?? firstTokenAtMs,
    metrics.lastOutputDeltaAtMs ?? firstTokenAtMs,
  );
  const thinkingDurationMs = durationBetween(
    metrics.firstReasoningDeltaAtMs,
    metrics.lastReasoningDeltaAtMs,
  );
  const outputDurationMs = durationBetween(
    metrics.firstOutputDeltaAtMs,
    metrics.lastOutputDeltaAtMs,
  );
  const generationDurationMs = lastTokenAtMs - firstTokenAtMs;
  return {
    ...common,
    ttftMs: Math.max(0, firstTokenAtMs - metrics.requestStartedAtMs),
    ...(thinkingDurationMs !== undefined && thinkingDurationMs > 0
      ? { thinkingDurationMs }
      : {}),
    ...(outputDurationMs !== undefined && outputDurationMs > 0
      ? { outputDurationMs }
      : {}),
    ...(generationDurationMs > 0 ? { generationDurationMs } : {}),
  };
}

function isRetryableFailure(metrics: ProviderProxyMetrics): boolean {
  return metrics.status === "failed"
    && (
      (
        metrics.httpStatus !== null
        && (
          metrics.httpStatus === 429
          || (metrics.httpStatus >= 500 && metrics.httpStatus <= 599)
        )
      )
      || metrics.errorType === "websocket_closed"
    );
}

function durationBetween(start: number | null, end: number | null): number | undefined {
  return start === null || end === null ? undefined : end - start;
}
