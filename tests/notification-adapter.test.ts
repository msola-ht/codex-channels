import { describe, expect, it } from "vitest";

import {
  toConversationInputEvent,
  toThreadStateEvent,
} from "../src/codex-client/index.js";

describe("Notification adapter", () => {
  it("maps complete Thread settings to a stable routing event", () => {
    expect(toThreadStateEvent({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: "high",
          serviceTier: "priority",
        },
      },
    })).toEqual({
      type: "thread.settings.updated",
      threadId: "thread-1",
      settings: {
        model: "gpt-5.6-sol",
        effort: "high",
        serviceTier: "priority",
      },
    });
  });

  it("preserves nullable effort and service tier values", () => {
    expect(toThreadStateEvent({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: null,
          serviceTier: null,
        },
      },
    })).toEqual({
      type: "thread.settings.updated",
      threadId: "thread-1",
      settings: {
        model: "gpt-5.6-sol",
        effort: null,
        serviceTier: null,
      },
    });
  });

  it("maps Thread lifecycle notifications without protocol envelopes", () => {
    expect(toThreadStateEvent({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    })).toEqual({ type: "thread.archived", threadId: "thread-1" });
    expect(toThreadStateEvent({
      method: "thread/deleted",
      params: { threadId: "thread-2" },
    })).toEqual({ type: "thread.deleted", threadId: "thread-2" });
    expect(toThreadStateEvent({
      method: "thread/closed",
      params: { threadId: "thread-3" },
    })).toEqual({ type: "thread.closed", threadId: "thread-3" });
  });

  it("ignores incomplete or unrelated notifications", () => {
    expect(toThreadStateEvent({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: "high",
        },
      },
    })).toBeUndefined();
    expect(toThreadStateEvent({
      method: "thread/deleted",
      params: { threadId: 1 },
    })).toBeUndefined();
    expect(toThreadStateEvent({
      method: "turn/started",
      params: { threadId: "thread-1" },
    })).toBeUndefined();
  });

  it("maps Turn, Item and Thread lifecycle notifications to stable Core events", () => {
    expect(toConversationInputEvent({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1" },
      },
    })).toEqual({
      type: "turn.started",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(toConversationInputEvent({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "完成",
          phase: "final_answer",
        },
      },
    })).toEqual({
      type: "item.agentMessage.completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "完成",
      phase: "final_answer",
    });
    expect(toConversationInputEvent({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: { type: "active", activeFlags: [] },
      },
    })).toEqual({
      type: "thread.status.changed",
      threadId: "thread-1",
      status: "active",
    });
    expect(toConversationInputEvent({
      method: "thread/closed",
      params: { threadId: "thread-1" },
    })).toEqual({ type: "thread.closed", threadId: "thread-1" });
  });

  it("maps Goal updates and clears to stable Core events", () => {
    expect(toConversationInputEvent({
      method: "thread/goal/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        goal: {
          threadId: "thread-1",
          objective: "完成 Gateway",
          status: "active",
          tokenBudget: 100_000,
          tokensUsed: 12_500,
          timeUsedSeconds: 90,
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      },
    })).toEqual({
      type: "thread.goal.updated",
      threadId: "thread-1",
      goal: {
        threadId: "thread-1",
        objective: "完成 Gateway",
        status: "active",
        tokenBudget: 100_000,
        tokensUsed: 12_500,
        timeUsedSeconds: 90,
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });
    expect(toConversationInputEvent({
      method: "thread/goal/cleared",
      params: { threadId: "thread-1" },
    })).toEqual({
      type: "thread.goal.cleared",
      threadId: "thread-1",
    });
  });

  it("maps account, MCP and warning notifications without generated response types", () => {
    expect(toConversationInputEvent({
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    })).toEqual({
      type: "account.updated",
      authMode: "chatgpt",
      planType: "pro",
    });
    expect(toConversationInputEvent({
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: null,
        name: "docs",
        status: "failed",
        error: "TOKEN=secret",
        failureReason: "reauthenticationRequired",
      },
    })).toEqual({
      type: "mcp.status.updated",
      threadId: null,
      name: "docs",
      status: "failed",
      error: "TOKEN=[REDACTED]",
      failureReason: "reauthenticationRequired",
    });
    expect(toConversationInputEvent({
      method: "warning",
      params: { threadId: null, message: "全局警告" },
    })).toEqual({
      type: "warning",
      threadId: null,
      message: "全局警告",
    });
  });

  it("rejects malformed supported Core notifications and ignores unknown methods", () => {
    expect(toConversationInputEvent({
      method: "thread/goal/updated",
      params: {
        threadId: "thread-1",
        turnId: null,
        goal: {
          threadId: "thread-other",
          objective: "错误绑定",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    })).toBeUndefined();
    expect(toConversationInputEvent({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "unknown", error: null },
      },
    })).toBeUndefined();
    expect(toConversationInputEvent({
      method: "account/updated",
      params: { authMode: "unknown-auth", planType: "pro" },
    })).toBeUndefined();
    expect(toConversationInputEvent({
      method: "account/updated",
      params: { authMode: "chatgpt" },
    })).toBeUndefined();
    expect(toConversationInputEvent({
      method: "future/notification",
      params: {},
    })).toBeUndefined();
  });
});
