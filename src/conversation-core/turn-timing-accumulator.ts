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
  private modelRequestCount = 0;
  private completedModelRequestCount = 0;
  private interruptedModelRequestCount = 0;
  private incompleteModelRequestCount = 0;
  private failedModelRequestCount = 0;
  private retryableFailureModelRequestCount = 0;
  private reasoningRequestCount = 0;
  private reasoningUsageCount = 0;
  private modelInputTokens: number | undefined;
  private modelCachedInputTokens: number | undefined;
  private modelInputUsageCount = 0;
  private modelCachedInputUsageCount = 0;
  private modelOutputTokens: number | undefined;
  private modelReasoningOutputTokens: number | undefined;
  private compactModel: string | undefined;
  private compactModelConflict = false;
  private compactRequestCount = 0;
  private compactUnsuccessfulRequestCount = 0;
  private compactInputTokens = 0;
  private compactCachedInputTokens = 0;
  private compactInputUsageCount = 0;
  private compactCachedInputUsageCount = 0;
  private compactOutputTokens = 0;

  constructor(readonly turnId: string) {}

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
    if (event.operation === "compact") {
      this.recordCompaction(event);
    }
  }

  output(
    turnId: string,
    fallbackUsage?: FallbackUsage,
  ): TurnOutputTiming | undefined {
    if (turnId !== this.turnId) return undefined;
    const result: TurnOutputTiming = {};
    this.appendModelRequestSummary(result);
    const tokenCounts = this.outputTokenCounts(fallbackUsage);
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
      result.modelRequestCount === undefined
      && result.nonReasoningOutputTokens === undefined
      && result.reasoningTokens === undefined
    ) {
      return undefined;
    }
    return result;
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
  }

  private appendModelRequestSummary(result: TurnOutputTiming): void {
    if (this.modelRequestCount === 0) return;
    result.modelRequestCount = this.modelRequestCount;
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
      };
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
}
