import { describe, expect, it, vi } from "vitest";

import type { ConversationTarget } from "../src/conversation-core/index.js";
import {
  createWeixinDoctor,
  renderWeixinDoctor,
} from "../src/surfaces/weixin/index.js";

const target: ConversationTarget = {
  surface: "weixin",
  accountId: "account-fixture@im.bot",
  conversationId: "actor-fixture@im.wechat",
};

describe("WeixinDoctor", () => {
  it("reduces valid private records to safe availability states", async () => {
    const doctor = createWeixinDoctor({
      accountId: target.accountId,
      credentialStore: {
        get: vi.fn(async () => ({
          version: 1 as const,
          accountId: target.accountId,
          baseUrl: "https://ilinkai.weixin.qq.com",
          botToken: "secret-bot-token",
          grantedAt: 1,
        })),
      },
      replyContextPersistence: {
        get: vi.fn(async () => ({
          version: 1 as const,
          accountId: target.accountId,
          actorId: target.conversationId,
          contextToken: "secret-context-token",
          updatedAt: 2,
        })),
      },
      cursorStore: {
        get: vi.fn(async () => "secret-cursor"),
      },
      pollingHealth: {
        snapshot: () => ({
          phase: "polling",
          consecutiveFailures: 0,
          lastSuccessfulPollAtMs: 1_000,
          resumeAtMs: null,
        }),
      },
    });

    const snapshot = await doctor.inspect(target);
    const rendered = renderWeixinDoctor(snapshot, 2_000);

    expect(snapshot).toEqual({
      credential: "available",
      replyContext: "available",
      cursor: "available",
      polling: {
        phase: "polling",
        consecutiveFailures: 0,
        lastSuccessfulPollAtMs: 1_000,
        resumeAtMs: null,
      },
    });
    expect(rendered).toContain("Bot 凭据：可用");
    expect(rendered).toContain("Token 状态：后台未报告失效");
    expect(rendered).not.toContain("secret-");
  });

  it("reports missing and unreadable records without exposing errors", async () => {
    const doctor = createWeixinDoctor({
      accountId: target.accountId,
      credentialStore: {
        get: vi.fn(async () => null),
      },
      replyContextPersistence: {
        get: vi.fn(async () => {
          throw new Error("secret reply context failure");
        }),
      },
      cursorStore: {
        get: vi.fn(async () => null),
      },
      pollingHealth: {
        snapshot: () => ({
          phase: "credential-pause",
          consecutiveFailures: 0,
          lastSuccessfulPollAtMs: null,
          resumeAtMs: 3_600_000,
        }),
      },
    });

    const rendered = renderWeixinDoctor(
      await doctor.inspect(target),
      0,
    );

    expect(rendered).toContain("Bot 凭据：尚未建立");
    expect(rendered).toContain("回复上下文：不可用");
    expect(rendered).toContain("后台游标：尚未建立");
    expect(rendered).toContain("Token 状态：未配置");
    expect(rendered).not.toContain("secret reply context failure");
  });
});
