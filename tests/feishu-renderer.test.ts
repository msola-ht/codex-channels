import { describe, expect, it } from "vitest";

import {
  isCriticalOutputEvent,
  type OutputEvent,
} from "../src/conversation-core/index.js";
import { renderFeishuOutput } from "../src/surfaces/feishu/index.js";

const target = {
  surface: "feishu",
  accountId: "cli_app",
  conversationId: "oc_chat",
} as const;

describe("Feishu output renderer", () => {
  it("renders a completed assistant message as plain text", () => {
    const event: OutputEvent = {
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "任务已完成。",
    };

    expect(renderFeishuOutput(event)).toBe("任务已完成。");
  });

  it("uses a visible fallback for a blank completed message", () => {
    const event: OutputEvent = {
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: " \n ",
    };

    expect(renderFeishuOutput(event)).toBe("Codex 返回了空消息。");
  });

  it("renders every critical output event and ignores non-critical progress", () => {
    const criticalEvents: OutputEvent[] = [
      {
        type: "user.message",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "user-1",
        text: "继续处理",
      },
      {
        type: "text.completed",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "assistant-1",
        text: "已处理",
      },
      {
        type: "operation.updated",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        operation: {
          itemId: "command-1",
          kind: "command",
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
      },
      {
        type: "thread.status",
        target,
        threadId: "thread-1",
        status: "idle",
      },
      {
        type: "connection.lost",
        target,
        threadId: "thread-1",
        message: "upstream secret",
      },
      {
        type: "account.updated",
        target,
        authMode: "chatgpt",
        planType: "pro",
      },
      {
        type: "account.rateLimits.updated",
        target,
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
      {
        type: "mcp.status.updated",
        target,
        threadId: "thread-1",
        name: "example",
        status: "failed",
        error: "upstream secret",
        failureReason: null,
      },
      {
        type: "warning",
        target,
        threadId: "thread-1",
        message: "upstream secret",
      },
    ];
    const progressEvents: OutputEvent[] = [
      {
        type: "turn.started",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      {
        type: "text.delta",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "assistant-1",
        text: "处理中",
      },
      {
        type: "operation.updated",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        operation: {
          itemId: "command-1",
          kind: "command",
          status: "running",
        },
      },
    ];

    expect(criticalEvents.every(isCriticalOutputEvent)).toBe(true);
    expect(criticalEvents.map(renderFeishuOutput).every((text) => Boolean(text?.trim()))).toBe(true);
    expect(progressEvents.some(isCriticalOutputEvent)).toBe(false);
    expect(progressEvents.map(renderFeishuOutput)).toEqual([null, null, null]);
  });

  it("hides upstream error and warning details", () => {
    const events: OutputEvent[] = [
      {
        type: "turn.completed",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        status: "failed",
        error: "token=secret",
      },
      {
        type: "connection.lost",
        target,
        threadId: "thread-1",
        message: "Authorization: secret",
      },
      {
        type: "mcp.status.updated",
        target,
        threadId: "thread-1",
        name: "example",
        status: "failed",
        error: "cookie=secret",
        failureReason: null,
      },
      {
        type: "warning",
        target,
        message: "upstream body secret",
      },
    ];

    const rendered = events.map(renderFeishuOutput).join("\n");
    expect(rendered).not.toContain("secret");
    expect(rendered).toContain("隐藏");
  });
});
