import { describe, expect, it } from "vitest";

import {
  renderWeixinPollingHealth,
  WeixinPollingHealth,
} from "../src/surfaces/weixin/index.js";

describe("WeixinPollingHealth", () => {
  it("reports polling success and a bounded retry delay without persisting payloads", () => {
    const health = new WeixinPollingHealth();

    health.start();
    health.recordSuccess(1_000);
    health.recordRetry({
      attempt: 2,
      code: "network-error",
      phase: "retry",
      delayMs: 2_000,
    }, 1_500);

    expect(health.snapshot()).toEqual({
      phase: "retry",
      consecutiveFailures: 2,
      lastSuccessfulPollAtMs: 1_000,
      resumeAtMs: 3_500,
    });
  });

  it("returns from a retry delay to polling and records an explicit stop", () => {
    const health = new WeixinPollingHealth();
    health.start();
    health.recordRetry({
      attempt: 1,
      code: "network-error",
      phase: "retry",
      delayMs: 2_000,
    }, 1_000);

    health.recordPollStart();
    expect(health.snapshot().phase).toBe("polling");
    expect(health.snapshot().consecutiveFailures).toBe(1);

    health.stop();
    expect(health.snapshot()).toMatchObject({
      phase: "stopped",
      resumeAtMs: null,
    });
  });

  it("renders a stale credential pause with a bounded recovery action", () => {
    expect(renderWeixinPollingHealth({
      phase: "credential-pause",
      consecutiveFailures: 0,
      lastSuccessfulPollAtMs: null,
      resumeAtMs: 3_601_000,
    }, 1_000)).toBe([
      "微信链路：Token 失效暂停",
      "连续失败：0 次",
      "最近成功轮询：尚无",
      "预计恢复：1小时后",
      "处理建议：重新运行 codexc setup",
    ].join("\n"));
  });
});
