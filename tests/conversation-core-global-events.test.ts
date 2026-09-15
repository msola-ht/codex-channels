import pino from "pino";
import { describe, expect, it } from "vitest";

import { ConversationCore } from "../src/conversation-core/core.js";
import type { OutputEvent } from "../src/conversation-core/events.js";
import { EventBus } from "../src/event-bus/event-bus.js";
import { handleNotification } from "./conversation-core-test-fixture.js";

describe("ConversationCore global events", () => {
  it("merges sparse rate-limit updates and broadcasts threshold crossings once", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex 5 小时",
          planType: "pro",
          primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 2_000_000_000 },
        },
      },
    });
    handleNotification(core, {
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          planType: null,
          primary: null,
        },
      },
    });
    handleNotification(core, {
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex", primary: { usedPercent: 50 } } },
    });
    handleNotification(core, {
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex", primary: { usedPercent: 91 } } },
    });
    handleNotification(core, {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "thread-1",
        name: "docs",
        status: "ready",
        error: null,
        failureReason: null,
      },
    });
    handleNotification(core, {
      method: "mcpServer/oauthLogin/completed",
      params: {
        threadId: "thread-1",
        name: "docs",
        success: true,
      },
    });
    await output.close();

    const limitEvents = events.filter((event) => event.type === "account.rateLimits.updated");
    expect(limitEvents).toHaveLength(2);
    expect(limitEvents.at(-1)).toMatchObject({
      rateLimits: {
        limitName: "Codex 5 小时",
        planType: "pro",
        primary: { windowDurationMins: 300, resetsAt: 2_000_000_000 },
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "mcp.status.updated",
      name: "docs",
    }));
    expect(events).toContainEqual({
      type: "mcp.oauth.completed",
      target,
      threadId: "thread-1",
      name: "docs",
      success: true,
      error: null,
    });
  });

  it("broadcasts global App Server warnings to bound conversations", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => undefined,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "warning",
      params: {
        threadId: null,
        message: "全局配置警告",
      },
    });
    await output.close();

    expect(events).toContainEqual({
      type: "warning",
      target,
      message: "全局配置警告",
    });
  });

  it("routes Provider-global MCP status and warnings only to matching conversations", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const openaiTarget = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "openai",
    };
    const deepseekTarget = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "deepseek",
    };
    const core = new ConversationCore({
      allBindings: () => [
        { target: openaiTarget, threadId: "thread-openai" },
        { target: deepseekTarget, threadId: "thread-deepseek" },
      ],
      targetForThread: () => undefined,
      modelSettingsForThread: (threadId) => threadId === "thread-deepseek"
        ? {
          model: "deepseek-v4-flash",
          modelProvider: "deepseek",
          effort: "high",
          serviceTier: null,
        }
        : {
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          effort: "medium",
          serviceTier: null,
        },
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: null,
        name: "codex_apps",
        status: "failed",
        error: null,
        failureReason: null,
      },
      provider: "deepseek",
    });
    handleNotification(core, {
      method: "mcpServer/oauthLogin/completed",
      params: {
        threadId: null,
        name: "codex_apps",
        success: false,
        error: "OAuth denied",
      },
      provider: "deepseek",
    });
    handleNotification(core, {
      method: "warning",
      params: { threadId: null, message: "DeepSeek 配置警告" },
      provider: "deepseek",
    });
    await output.close();

    expect(events).toEqual([
      expect.objectContaining({
        type: "mcp.status.updated",
        target: deepseekTarget,
        name: "codex_apps",
        status: "failed",
      }),
      {
        type: "warning",
        target: deepseekTarget,
        message: "DeepSeek 配置警告",
      },
    ]);
  });

  it("publishes MCP failure and recovery but not normal startup progress", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "100",
    };
    const core = new ConversationCore({
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);
    const status = (value: "starting" | "ready" | "failed") => {
      handleNotification(core, {
        method: "mcpServer/startupStatus/updated",
        params: {
          threadId: "thread-1",
          name: "docs",
          status: value,
          error: value === "failed" ? "连接失败" : null,
          failureReason: null,
        },
      });
    };

    status("starting");
    status("ready");
    status("failed");
    status("starting");
    status("ready");
    await output.close();

    expect(events).toEqual([
      expect.objectContaining({
        type: "mcp.status.updated",
        name: "docs",
        status: "failed",
      }),
      expect.objectContaining({
        type: "mcp.status.updated",
        name: "docs",
        status: "ready",
      }),
    ]);
  });
});
