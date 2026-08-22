import { describe, expect, it } from "vitest";

import { enqueueTurnErrorMetric } from "../src/bootstrap/turn-error-metrics.js";
import type { ModelRequestMetricSample } from "../src/observability/index.js";

describe("enqueueTurnErrorMetric", () => {
  it("records an async usage-limit Turn error with the full message", () => {
    const metrics: ModelRequestMetricSample[] = [];
    enqueueTurnErrorMetric(
      { enqueue: (metric) => metrics.push(metric) },
      "openai",
      "gpt-5.6-sol",
      "thread-1",
      "turn-1",
      "notification",
      new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"),
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      threadId: "thread-1",
      turnId: "turn-1",
      operation: "response",
      status: "failed",
      httpStatus: null,
      errorType: "usage_limit_reached",
      errorCode: null,
      errorMessage: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage",
      weeklyQuota: null,
    });
  });

  it("preserves a numeric RPC error code and collapses whitespace", () => {
    const metrics: ModelRequestMetricSample[] = [];
    const error = new Error("Turn 启动失败\n\n请稍后重试");
    (error as { code?: unknown }).code = -32_601;
    enqueueTurnErrorMetric(
      { enqueue: (metric) => metrics.push(metric) },
      "deepseek",
      "deepseek-v4-flash",
      "thread-2",
      null,
      "start",
      error,
    );

    expect(metrics[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      threadId: "thread-2",
      turnId: null,
      status: "failed",
      errorType: "turn_start_error",
      errorCode: "rpc:-32601",
      errorMessage: "Turn 启动失败 请稍后重试",
    });
  });

  it("preserves the structured misalignment policy classification", () => {
    const metrics: ModelRequestMetricSample[] = [];
    enqueueTurnErrorMetric(
      { enqueue: (metric) => metrics.push(metric) },
      "openai",
      "gpt-5.6-sol",
      "thread-3",
      "turn-3",
      "notification",
      new Error("untrusted upstream policy text"),
      "misalignmentPolicyViolation",
    );

    expect(metrics[0]).toMatchObject({
      provider: "openai",
      threadId: "thread-3",
      turnId: "turn-3",
      errorType: "misalignment_policy_violation",
      errorCode: "misalignmentPolicyViolation",
    });
  });
});
