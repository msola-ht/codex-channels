import type { ThreadTokenUsage, TurnOutputTiming } from "./events.js";
import type { ConversationInputEvent } from "./input-events.js";

type ModelTimingEvent = Extract<
  ConversationInputEvent,
  { type: "turn.modelTiming.updated" }
>;

type FallbackUsage = Pick<
  ThreadTokenUsage["last"],
  "outputTokens" | "reasoningOutputTokens"
>;

export class TurnTimingAccumulator {
  private firstAnyDeltaAtMs: number | undefined;
  private lastAnyDeltaAtMs: number | undefined;
  private modelOutputDurationMs: number | undefined;
  private modelTtftMs: number | undefined;
  private modelRequestStartedAtMs: number | undefined;
  private modelRequestCount = 0;
  private completedModelRequestCount = 0;
  private interruptedModelRequestCount = 0;
  private incompleteModelRequestCount = 0;
  private failedModelRequestCount = 0;
  private retryableFailureModelRequestCount = 0;
  private reasoningRequestCount = 0;
  private reasoningUsageCount = 0;
  private modelRequestDurationMs = 0;
  private modelInputTokens: number | undefined;
  private modelCachedInputTokens: number | undefined;
  private modelInputUsageCount = 0;
  private modelCachedInputUsageCount = 0;
  private modelOutputTokens: number | undefined;
  private modelReasoningOutputTokens: number | undefined;
  private pricingCurrency: string | undefined;
  private pricingCurrencyConflict = false;
  private uncachedInputPricePerMillionNanos: number | undefined;
  private cachedInputPricePerMillionNanos: number | undefined;
  private outputPricePerMillionNanos: number | undefined;
  private pricingRateSignature: string | undefined;
  private pricingRateConflict = false;
  private pricingBuckets: Set<"peak" | "off-peak"> | undefined;
  private pricedRequestCount = 0;
  private totalCostNanos = 0;
  private uncachedInputCostNanos = 0;
  private cachedInputCostNanos = 0;
  private outputCostNanos = 0;
  private compactModel: string | undefined;
  private compactModelConflict = false;
  private compactRequestCount = 0;
  private compactUnsuccessfulRequestCount = 0;
  private compactInputTokens = 0;
  private compactCachedInputTokens = 0;
  private compactInputUsageCount = 0;
  private compactCachedInputUsageCount = 0;
  private compactOutputTokens = 0;
  private compactPricingCurrency: string | undefined;
  private compactPricingCurrencyConflict = false;
  private compactPricedRequestCount = 0;
  private compactTotalCostNanos = 0;
  private timedNonReasoningOutputTokens = 0;
  private timedOutputDurationMs = 0;
  private outputSpeedSampleCount = 0;
  private outputSpeedTimedCount = 0;
  private timedReasoningOutputTokens = 0;
  private timedThinkingDurationMs = 0;
  private thinkingSpeedSampleCount = 0;
  private thinkingSpeedTimedCount = 0;
  private timedGenerationOutputTokens = 0;
  private timedGenerationDurationMs = 0;
  private generationSpeedSampleCount = 0;
  private generationSpeedTimedCount = 0;
  private readonly finalItemDeltas = new Map<
    string,
    { firstAtMs: number; lastAtMs: number }
  >();

  constructor(
    readonly turnId: string,
    private readonly turnStartedAtMs?: number,
  ) {}

  recordAgentMessageDelta(
    turnId: string,
    itemKey: string,
    receivedAtMs: number,
    finalAnswer: boolean,
  ): void {
    if (turnId !== this.turnId) return;
    this.firstAnyDeltaAtMs ??= receivedAtMs;
    this.lastAnyDeltaAtMs = receivedAtMs;
    if (!finalAnswer) return;
    const itemTiming = this.finalItemDeltas.get(itemKey)
      ?? { firstAtMs: receivedAtMs, lastAtMs: receivedAtMs };
    itemTiming.lastAtMs = receivedAtMs;
    this.finalItemDeltas.set(itemKey, itemTiming);
  }

  recordModelTiming(event: ModelTimingEvent): void {
    if (event.turnId !== this.turnId) return;
    this.modelRequestCount += 1;
    switch (event.outcome ?? "completed") {
      case "completed":
        this.completedModelRequestCount += 1;
        break;
      case "interrupted":
        this.interruptedModelRequestCount += 1;
        break;
      case "incomplete":
        this.incompleteModelRequestCount += 1;
        break;
      case "failed":
        this.failedModelRequestCount += 1;
        if (event.retryableFailure) {
          this.retryableFailureModelRequestCount += 1;
        }
        break;
    }
    this.modelRequestDurationMs += event.requestDurationMs;
    if (event.inputTokens !== undefined) {
      this.modelInputTokens = (this.modelInputTokens ?? 0) + event.inputTokens;
      this.modelInputUsageCount += 1;
    }
    if (event.cachedInputTokens !== undefined) {
      this.modelCachedInputTokens =
        (this.modelCachedInputTokens ?? 0) + event.cachedInputTokens;
      this.modelCachedInputUsageCount += 1;
    }
    if (event.outputTokens !== undefined) {
      this.modelOutputTokens = (this.modelOutputTokens ?? 0) + event.outputTokens;
    }
    if (event.reasoningOutputTokens !== undefined) {
      this.reasoningUsageCount += 1;
      this.modelReasoningOutputTokens =
        (this.modelReasoningOutputTokens ?? 0) + event.reasoningOutputTokens;
      if (event.reasoningOutputTokens > 0) {
        this.reasoningRequestCount += 1;
      }
    }
    this.recordPricing(event);
    if (event.operation === "compact") {
      this.recordCompaction(event);
    }
    this.recordSpeeds(event);
    if (event.outputDurationMs !== undefined) {
      this.modelOutputDurationMs =
        (this.modelOutputDurationMs ?? 0) + event.outputDurationMs;
    }
    if (
      this.modelRequestStartedAtMs === undefined
      || event.requestStartedAtMs >= this.modelRequestStartedAtMs
    ) {
      this.modelRequestStartedAtMs = event.requestStartedAtMs;
      this.modelTtftMs = event.ttftMs;
    }
  }

  output(
    turnId: string,
    detailedTiming: boolean,
    fallbackUsage?: FallbackUsage,
  ): TurnOutputTiming | undefined {
    if (turnId !== this.turnId) return undefined;
    const result: TurnOutputTiming = {};
    this.appendModelRequestSummary(result);
    if (detailedTiming && this.modelTtftMs !== undefined) {
      result.ttftMs = this.modelTtftMs;
    }
    if (
      this.turnStartedAtMs !== undefined
      && this.firstAnyDeltaAtMs !== undefined
      && this.firstAnyDeltaAtMs >= this.turnStartedAtMs
    ) {
      result.firstResponseLatencyMs = this.firstAnyDeltaAtMs - this.turnStartedAtMs;
    }
    this.appendOutputDuration(result);
    const tokenCounts = this.outputTokenCounts(fallbackUsage);
    this.appendSpeeds(result, tokenCounts, detailedTiming);
    if (
      result.modelRequestCount === undefined
      && result.firstResponseLatencyMs === undefined
      && result.outputDurationMs === undefined
      && result.thinkingDurationMs === undefined
    ) {
      return undefined;
    }
    return result;
  }

  private recordPricing(event: ModelTimingEvent): void {
    if (
      event.pricingCurrency === undefined
      || event.totalCostNanos === undefined
    ) {
      return;
    }
    if (event.pricingBucket !== undefined) {
      this.pricingBuckets ??= new Set();
      this.pricingBuckets.add(event.pricingBucket);
    }
    const rateSignature = [
      event.uncachedInputPricePerMillionNanos ?? "missing",
      event.cachedInputPricePerMillionNanos ?? "missing",
      event.outputPricePerMillionNanos ?? "missing",
    ].join(":");
    if (
      this.pricingCurrency !== undefined
      && this.pricingCurrency !== event.pricingCurrency
    ) {
      this.pricingCurrencyConflict = true;
    }
    this.pricingCurrency ??= event.pricingCurrency;
    if (
      this.pricingRateSignature !== undefined
      && this.pricingRateSignature !== rateSignature
    ) {
      this.pricingRateConflict = true;
    }
    this.pricingRateSignature ??= rateSignature;
    this.uncachedInputPricePerMillionNanos ??=
      event.uncachedInputPricePerMillionNanos;
    this.cachedInputPricePerMillionNanos ??=
      event.cachedInputPricePerMillionNanos;
    this.outputPricePerMillionNanos ??= event.outputPricePerMillionNanos;
    this.pricedRequestCount += 1;
    this.totalCostNanos += event.totalCostNanos;
    this.uncachedInputCostNanos += event.uncachedInputCostNanos ?? 0;
    this.cachedInputCostNanos += event.cachedInputCostNanos ?? 0;
    this.outputCostNanos += event.outputCostNanos ?? 0;
  }

  private recordCompaction(event: ModelTimingEvent): void {
    this.compactRequestCount += 1;
    if ((event.outcome ?? "completed") !== "completed") {
      this.compactUnsuccessfulRequestCount += 1;
    }
    if (event.model !== undefined) {
      if (this.compactModel !== undefined && this.compactModel !== event.model) {
        this.compactModelConflict = true;
      }
      this.compactModel ??= event.model;
    }
    if (event.inputTokens !== undefined) {
      this.compactInputTokens += event.inputTokens;
      this.compactInputUsageCount += 1;
    }
    if (event.cachedInputTokens !== undefined) {
      this.compactCachedInputTokens += event.cachedInputTokens;
      this.compactCachedInputUsageCount += 1;
    }
    if (event.outputTokens !== undefined) {
      this.compactOutputTokens += event.outputTokens;
    }
    if (
      event.pricingCurrency === undefined
      || event.totalCostNanos === undefined
    ) {
      return;
    }
    if (
      this.compactPricingCurrency !== undefined
      && this.compactPricingCurrency !== event.pricingCurrency
    ) {
      this.compactPricingCurrencyConflict = true;
    }
    this.compactPricingCurrency ??= event.pricingCurrency;
    this.compactPricedRequestCount += 1;
    this.compactTotalCostNanos += event.totalCostNanos;
  }

  private recordSpeeds(event: ModelTimingEvent): void {
    if (event.outputTokens !== undefined) {
      const nonReasoningOutputTokens = Math.max(
        0,
        event.outputTokens - (event.reasoningOutputTokens ?? 0),
      );
      if (nonReasoningOutputTokens > 0) {
        this.outputSpeedSampleCount += 1;
        if (event.outputDurationMs !== undefined && event.outputDurationMs > 0) {
          this.outputSpeedTimedCount += 1;
          this.timedNonReasoningOutputTokens += nonReasoningOutputTokens;
          this.timedOutputDurationMs += event.outputDurationMs;
        }
      }
      if (event.outputTokens > 0) {
        this.generationSpeedSampleCount += 1;
        if (
          event.generationDurationMs !== undefined
          && event.generationDurationMs > 0
        ) {
          this.generationSpeedTimedCount += 1;
          this.timedGenerationOutputTokens += event.outputTokens;
          this.timedGenerationDurationMs += event.generationDurationMs;
        }
      }
    }
    if (
      event.reasoningOutputTokens !== undefined
      && event.reasoningOutputTokens > 0
    ) {
      this.thinkingSpeedSampleCount += 1;
      if (event.thinkingDurationMs !== undefined && event.thinkingDurationMs > 0) {
        this.thinkingSpeedTimedCount += 1;
        this.timedReasoningOutputTokens += event.reasoningOutputTokens;
        this.timedThinkingDurationMs += event.thinkingDurationMs;
      }
    }
  }

  private appendModelRequestSummary(result: TurnOutputTiming): void {
    if (this.modelRequestCount === 0) return;
    result.modelRequestCount = this.modelRequestCount;
    if (this.modelRequestStartedAtMs !== undefined) {
      result.modelRequestStartedAtMs = this.modelRequestStartedAtMs;
    }
    if (
      this.interruptedModelRequestCount > 0
      || this.incompleteModelRequestCount > 0
      || this.failedModelRequestCount > 0
    ) {
      result.completedModelRequestCount = this.completedModelRequestCount;
      result.interruptedModelRequestCount = this.interruptedModelRequestCount;
      result.incompleteModelRequestCount = this.incompleteModelRequestCount;
      result.failedModelRequestCount = this.failedModelRequestCount;
      result.retryableFailureModelRequestCount =
        this.retryableFailureModelRequestCount;
    }
    if (this.reasoningUsageCount > 0) {
      result.reasoningRequestCount = this.reasoningRequestCount;
    }
    result.modelRequestDurationMs = this.modelRequestDurationMs;
    if (this.modelInputTokens !== undefined) {
      result.requestInputTokens = this.modelInputTokens;
    }
    if (
      this.modelCachedInputTokens !== undefined
      && this.modelInputUsageCount > 0
      && this.modelCachedInputUsageCount === this.modelInputUsageCount
    ) {
      result.requestCachedInputTokens = this.modelCachedInputTokens;
    }
    if (this.modelOutputTokens !== undefined) {
      result.requestOutputTokens = this.modelOutputTokens;
    }
    result.referenceCost = {
      currency: this.pricingCurrencyConflict
        ? null
        : this.pricingCurrency ?? null,
      totalCostNanos: this.pricingCurrencyConflict
        || this.pricedRequestCount === 0
        ? null
        : this.totalCostNanos,
      inputCostNanos: this.pricingCurrencyConflict
        || this.pricedRequestCount === 0
        ? null
        : this.uncachedInputCostNanos,
      cachedInputCostNanos: this.pricingCurrencyConflict
        || this.pricedRequestCount === 0
        ? null
        : this.cachedInputCostNanos,
      outputCostNanos: this.pricingCurrencyConflict
        || this.pricedRequestCount === 0
        ? null
        : this.outputCostNanos,
      pricedRequestCount: this.pricedRequestCount,
      requestCount: this.modelRequestCount,
      uncachedInputPricePerMillionNanos: this.pricingRateConflict
        ? null
        : this.uncachedInputPricePerMillionNanos ?? null,
      cachedInputPricePerMillionNanos: this.pricingRateConflict
        ? null
        : this.cachedInputPricePerMillionNanos ?? null,
      outputPricePerMillionNanos: this.pricingRateConflict
        ? null
        : this.outputPricePerMillionNanos ?? null,
      hasMixedPrices: this.pricingCurrencyConflict || this.pricingRateConflict,
      ...(this.pricingBuckets !== undefined && this.pricingBuckets.size > 0
        ? { pricingBuckets: sortedPricingBuckets(this.pricingBuckets) }
        : {}),
    };
    if (this.compactRequestCount > 0) {
      result.compact = {
        model: this.compactModelConflict ? null : this.compactModel ?? null,
        hasMixedModels: this.compactModelConflict,
        requestCount: this.compactRequestCount,
        unsuccessfulRequestCount: this.compactUnsuccessfulRequestCount,
        inputTokens: this.compactInputTokens,
        cachedInputTokens: this.compactInputUsageCount > 0
          && this.compactCachedInputUsageCount === this.compactInputUsageCount
          ? this.compactCachedInputTokens
          : null,
        outputTokens: this.compactOutputTokens,
        pricingCurrency: this.compactPricingCurrencyConflict
          ? null
          : this.compactPricingCurrency ?? null,
        pricedRequestCount: this.compactPricedRequestCount,
        totalCostNanos: this.compactPricingCurrencyConflict
          || this.compactPricedRequestCount === 0
          ? null
          : this.compactTotalCostNanos,
      };
    }
  }

  private appendOutputDuration(result: TurnOutputTiming): void {
    if (this.modelOutputDurationMs !== undefined) {
      result.outputDurationMs = this.modelOutputDurationMs;
      return;
    }
    if (this.finalItemDeltas.size > 0) {
      let totalOutputDurationMs = 0;
      for (const itemTiming of this.finalItemDeltas.values()) {
        if (itemTiming.lastAtMs >= itemTiming.firstAtMs) {
          totalOutputDurationMs += itemTiming.lastAtMs - itemTiming.firstAtMs;
        }
      }
      if (totalOutputDurationMs > 0) {
        result.outputDurationMs = totalOutputDurationMs;
      }
      return;
    }
    if (
      this.firstAnyDeltaAtMs !== undefined
      && this.lastAnyDeltaAtMs !== undefined
      && this.lastAnyDeltaAtMs >= this.firstAnyDeltaAtMs
    ) {
      result.outputDurationMs = this.lastAnyDeltaAtMs - this.firstAnyDeltaAtMs;
    }
  }

  private outputTokenCounts(fallbackUsage?: FallbackUsage): {
    nonReasoningOutputTokens?: number;
    reasoningTokens?: number;
  } {
    if (this.modelOutputTokens !== undefined) {
      const reasoningTokens = Math.max(0, this.modelReasoningOutputTokens ?? 0);
      return {
        nonReasoningOutputTokens: Math.max(
          0,
          this.modelOutputTokens - reasoningTokens,
        ),
        reasoningTokens,
      };
    }
    if (!fallbackUsage) return {};
    return {
      nonReasoningOutputTokens: Math.max(
        0,
        fallbackUsage.outputTokens - fallbackUsage.reasoningOutputTokens,
      ),
      reasoningTokens: Math.max(0, fallbackUsage.reasoningOutputTokens),
    };
  }

  private appendSpeeds(
    result: TurnOutputTiming,
    tokenCounts: {
      nonReasoningOutputTokens?: number;
      reasoningTokens?: number;
    },
    detailedTiming: boolean,
  ): void {
    if (
      this.outputSpeedTimedCount > 0
      && this.timedNonReasoningOutputTokens > 0
      && this.timedOutputDurationMs > 0
    ) {
      result.outputTokensPerSecond =
        this.timedNonReasoningOutputTokens / (this.timedOutputDurationMs / 1_000);
      result.outputSpeedSampleCount = this.outputSpeedSampleCount;
      result.outputSpeedTimedCount = this.outputSpeedTimedCount;
    } else if (
      this.modelRequestCount === 0
      && tokenCounts.nonReasoningOutputTokens !== undefined
      && tokenCounts.nonReasoningOutputTokens > 0
      && result.outputDurationMs !== undefined
      && result.outputDurationMs > 0
    ) {
      result.outputTokensPerSecond =
        tokenCounts.nonReasoningOutputTokens / (result.outputDurationMs / 1_000);
    }
    if (
      tokenCounts.nonReasoningOutputTokens !== undefined
      && tokenCounts.nonReasoningOutputTokens > 0
    ) {
      result.nonReasoningOutputTokens = tokenCounts.nonReasoningOutputTokens;
    }
    if (tokenCounts.reasoningTokens !== undefined && tokenCounts.reasoningTokens > 0) {
      result.reasoningTokens = tokenCounts.reasoningTokens;
    }
    if (
      detailedTiming
      && this.thinkingSpeedTimedCount > 0
      && this.timedReasoningOutputTokens > 0
      && this.timedThinkingDurationMs > 0
    ) {
      result.thinkingTokensPerSecond =
        this.timedReasoningOutputTokens / (this.timedThinkingDurationMs / 1_000);
      result.thinkingDurationMs = this.timedThinkingDurationMs;
      result.thinkingSpeedSampleCount = this.thinkingSpeedSampleCount;
      result.thinkingSpeedTimedCount = this.thinkingSpeedTimedCount;
    }
    if (
      detailedTiming
      && this.generationSpeedTimedCount > 0
      && this.timedGenerationOutputTokens > 0
      && this.timedGenerationDurationMs > 0
    ) {
      result.generationTokensPerSecond =
        this.timedGenerationOutputTokens / (this.timedGenerationDurationMs / 1_000);
      result.generationSpeedSampleCount = this.generationSpeedSampleCount;
      result.generationSpeedTimedCount = this.generationSpeedTimedCount;
    }
  }
}

function sortedPricingBuckets(
  buckets: ReadonlySet<"peak" | "off-peak">,
): Array<"peak" | "off-peak"> {
  const order: ReadonlyArray<"peak" | "off-peak"> = ["off-peak", "peak"];
  return order.filter((bucket) => buckets.has(bucket));
}
