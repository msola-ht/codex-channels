import type { Logger } from "pino";

import type { ConversationInputEvent } from "../conversation-core/index.js";
import type { ModelRequestMetricsWriter } from "../observability/index.js";
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
    try {
      this.options.writer.enqueue({ provider, ...metrics });
    } catch (error) {
      this.options.logger.warn({ err: error, provider }, "模型请求指标持久化失败");
    }
    const event = toModelTimingEvent(metrics);
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
): ModelTimingEvent | undefined {
  const firstTokenAtMs = metrics.firstTokenAtMs;
  if (metrics.threadId === null || metrics.turnId === null || firstTokenAtMs === null) {
    return undefined;
  }
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
    type: "turn.modelTiming.updated",
    threadId: metrics.threadId,
    turnId: metrics.turnId,
    requestStartedAtMs: metrics.requestStartedAtMs,
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

function durationBetween(start: number | null, end: number | null): number | undefined {
  return start === null || end === null ? undefined : end - start;
}
