import { describe, expect, it } from "vitest";

import { formatConversationMetrics } from "../src/surfaces/conversation-command-format.js";

describe("conversation metrics formatting", () => {
  it("renders latest Turn and Thread aggregates", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        threadId: "thread-1",
        modelProvider: "deepseek",
        latestTurn: {
          turnId: "turn-1",
          requestCount: 3,
          unsuccessfulRequestCount: 1,
          requestOutcomes: { completed: 2, interrupted: 1, failed: 0, incomplete: 0 },
          interruptionSummary: { followedByCompletion: 1, noObservedCompletion: 0, usageUnobserved: 1 },
          inputTokens: 30_000,
          cachedInputTokens: 24_000,
          outputTokens: 900,
          reasoningOutputTokens: 300,
          compact: {
            model: "gpt-5.6-sol",
            hasMixedModels: false,
            requestCount: 1,
            unsuccessfulRequestCount: 0,
            requestOutcomes: { completed: 1, interrupted: 0, failed: 0, incomplete: 0 },
            inputTokens: 10_000,
            cachedInputTokens: 9_000,
            outputTokens: 500,
          },
        },
        threadAggregate: {
          turnCount: 8,
          requestCount: 21,
          unsuccessfulRequestCount: 2,
          requestOutcomes: { completed: 19, interrupted: 1, failed: 0, incomplete: 1 },
          interruptionSummary: { followedByCompletion: 1, noObservedCompletion: 0, usageUnobserved: 1 },
          inputTokens: 180_000,
          cachedInputTokens: 174_000,
          outputTokens: 4_200,
          reasoningOutputTokens: 1_800,
          compact: {
            model: "gpt-5.6-sol",
            hasMixedModels: false,
            requestCount: 2,
            unsuccessfulRequestCount: 0,
            requestOutcomes: { completed: 2, interrupted: 0, failed: 0, incomplete: 0 },
            inputTokens: 20_000,
            cachedInputTokens: 18_000,
            outputTokens: 1_000,
          },
        },
      },
    });

    expect(rendered).toContain("模型请求：3 次");
    expect(rendered).toContain("完成：2 · 客户端中断：1 · 其他失败：0 · 未完整观测：0");
    expect(rendered).toContain("同一 Turn 后续有完成 1 次 · 未观测到后续完成 0 次");
    expect(rendered).toContain("中断请求用量未完整观测：1 次");
    expect(rendered).toContain("不代表重试或恢复因果");
    expect(rendered).not.toContain("异常 1 次");
    expect(rendered).not.toContain("Token/s");
    expect(rendered).toContain("缓存命中率：80.00%");
    expect(rendered).toContain("其中推理输出：300");
    expect(rendered).toContain("其中推理输出：1.8 K");
    expect(rendered).toContain("### 最近运行聚合");
    expect(rendered).toContain("**Token**：30.9 K");
    expect(rendered).toContain("  - 缓存：24 K");
    expect(rendered).toContain("**Token**：184.2 K");
    expect(rendered).toContain("上下文压缩：1 次 · gpt-5.6-sol · 10.5 K Token");
    expect(rendered).toContain("### 当前会话指标累计");
    expect(rendered).toContain("Turn：8 次");
    expect(rendered).toContain("上下文压缩：2 次 · gpt-5.6-sol · 21 K Token");
    expect(rendered).not.toContain("最近直接 API");
    expect(rendered).not.toContain("耗时");
    expect(rendered).not.toContain("延迟");
    expect(rendered).not.toContain("速度");
  });

  it("shows reasoning token details for OpenAI official metrics", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        threadId: "thread-openai",
        modelProvider: "openai",
        latestTurn: {
          turnId: "turn-1",
          requestCount: 3,
          unsuccessfulRequestCount: 1,
          requestOutcomes: { completed: 2, interrupted: 0, failed: 1, incomplete: 0 },
          interruptionSummary: { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 },
          inputTokens: 30_000,
          cachedInputTokens: 24_000,
          outputTokens: 900,
          reasoningOutputTokens: 300,
          compact: null,
        },
        threadAggregate: {
          turnCount: 8,
          requestCount: 21,
          unsuccessfulRequestCount: 2,
          requestOutcomes: { completed: 19, interrupted: 0, failed: 2, incomplete: 0 },
          interruptionSummary: { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 },
          inputTokens: 180_000,
          cachedInputTokens: 174_000,
          outputTokens: 4_200,
          reasoningOutputTokens: 1_800,
          compact: null,
        },
      },
    });

    expect(rendered).toContain("其中推理输出：300");
    expect(rendered).toContain("其中推理输出：1.8 K");
  });

  it("renders unified provider and model request aggregates", () => {
    const aggregate = {
      requestCount: 7_955,
      unsuccessfulRequestCount: 1_234,
      requestOutcomes: { completed: 6_721, interrupted: 1_200, failed: 30, incomplete: 4 },
      inputTokens: 120_000,
      cachedInputTokens: 96_000,
      outputTokens: 2_400,
      reasoningOutputTokens: 600,
      compact: {
        model: "gpt-5.6-sol",
        hasMixedModels: false,
        requestCount: 2,
        unsuccessfulRequestCount: 0,
        requestOutcomes: { completed: 2, interrupted: 0, failed: 0, incomplete: 0 },
        inputTokens: 20_000,
        cachedInputTokens: 18_000,
        outputTokens: 1_000,
      },
    };
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        view: "models",
        range: "7d",
        startAtMs: 1,
        endAtMs: 2,
        aggregate,
        groups: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          aggregate,
        }, {
          provider: "custom",
          model: "gpt-5.6-luna",
          aggregate: { ...aggregate, requestCount: 999_999 },
        }],
        totalGroupCount: 2,
      },
    });

    expect(rendered).toContain("请求指标 · 按模型");
    expect(rendered).toContain("范围：最近 7 天");
    expect(rendered).toContain("模型请求：7.96 K 次");
    expect(rendered).toContain("客户端中断：1.2 K · 其他失败：30 · 未完整观测：4");
    expect(rendered).toContain("OpenAI 官方 / gpt-5.6-sol");
    expect(rendered).toContain("custom / gpt-5.6-luna");
    expect(rendered).toContain("请求：1 M 次");
    expect(rendered).toContain("上下文压缩：2 次 · gpt-5.6-sol · 21 K Token");
    expect(rendered).not.toContain("耗时");
    expect(rendered).not.toContain("延迟");
    expect(rendered).not.toContain("速度");
  });

  it("renders unsuccessful request groups and failure rate", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        view: "errors",
        range: "24h",
        startAtMs: 1,
        endAtMs: 2,
        requestCount: 100,
        unsuccessfulRequestCount: 3,
        requestOutcomes: { completed: 97, interrupted: 2, failed: 0, incomplete: 1 },
        groups: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          status: "failed",
          httpStatus: null,
          errorType: "client_disconnected",
          lastErrorMessage: null,
          requestCount: 2,
          lastOccurredAtMs: 1_785_640_800_000,
        }, {
          provider: "custom",
          model: "gpt-5.6-luna",
          status: "incomplete",
          httpStatus: 429,
          errorType: "rate_limit_error",
          lastErrorMessage: null,
          requestCount: 1,
          lastOccurredAtMs: 1_785_640_700_000,
        }],
        totalGroupCount: 2,
      },
    });

    expect(rendered).toContain("## 请求指标 · 中断、失败与未完整观测");
    expect(rendered).toContain("其他失败率：0%");
    expect(rendered).toContain("OpenAI 官方 / gpt-5.6-sol");
    expect(rendered).toContain("客户端提前断开 · 客户端中断 · 2 次");
    expect(rendered).not.toContain("客户端提前断开 · 其他失败");
    expect(rendered).toContain("custom / gpt-5.6-luna");
    expect(rendered).toContain("rate_limit_error · 未完整观测 · HTTP 429 · 1 次");
    expect(rendered).toContain("最近发生：");
    expect(rendered).toContain(`时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  });

  it("does not render untrusted error types as channel markdown", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        view: "errors",
        range: "24h",
        startAtMs: 1,
        endAtMs: 2,
        requestCount: 1,
        unsuccessfulRequestCount: 1,
        requestOutcomes: { completed: 0, interrupted: 0, failed: 1, incomplete: 0 },
        groups: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          status: "failed",
          httpStatus: 500,
          errorType: "upstream_error\n**伪造字段**",
          lastErrorMessage: null,
          requestCount: 1,
          lastOccurredAtMs: 1_785_640_800_000,
        }],
        totalGroupCount: 1,
      },
    });

    expect(rendered).toContain("其他错误 · 其他失败 · HTTP 500");
    expect(rendered).not.toContain("伪造字段");
    expect(rendered).not.toContain("**");
  });
});
