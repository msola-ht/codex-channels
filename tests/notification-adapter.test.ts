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
          collaborationMode: { mode: "plan", settings: {} },
        },
      },
    })).toEqual({
      type: "thread.settings.updated",
      threadId: "thread-1",
      settings: {
        model: "gpt-5.6-sol",
        effort: "high",
        serviceTier: "priority",
        collaborationMode: "plan",
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
          collaborationMode: { mode: "default", settings: {} },
        },
      },
    })).toEqual({
      type: "thread.settings.updated",
      threadId: "thread-1",
      settings: {
        model: "gpt-5.6-sol",
        effort: null,
        serviceTier: null,
        collaborationMode: "default",
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
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "item-2",
          kind: "started",
          agentThreadId: "subagent-thread-1",
          agentPath: "/root/ds_probe",
        },
      },
    })).toBeUndefined();
    expect(toConversationInputEvent({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "item-2",
          kind: "started",
          agentThreadId: "subagent-thread-1",
          agentPath: "/root/ds_probe",
        },
      },
    })).toEqual({
      type: "item.subagentActivity",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      agentThreadId: "subagent-thread-1",
      agentPath: "/root/ds_probe",
      kind: "started",
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

  it("preserves official subagent states from completed wait calls", () => {
    expect(toConversationInputEvent({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "wait-1",
          tool: "wait",
          status: "completed",
          senderThreadId: "thread-1",
          receiverThreadIds: ["agent-2", "agent-1"],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {
            "agent-2": { status: "errored", message: "任务失败" },
            "agent-1": { status: "completed", message: "任务完成" },
          },
        },
      },
    })).toEqual({
      type: "item.operation.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      operation: {
        itemId: "wait-1",
        kind: "subagent",
        action: "wait",
        status: "failed",
        receiverThreadIds: ["agent-2", "agent-1"],
        subagentStates: [
          { threadId: "agent-1", status: "completed" },
          { threadId: "agent-2", status: "errored" },
        ],
      },
    });
  });

  it("propagates the receipt timestamp for turn start and text deltas", () => {
    expect(toConversationInputEvent({
      method: "turn/started",
      receivedAtMs: 123,
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    })).toEqual({
      type: "turn.started",
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAtMs: 123,
    });
    expect(toConversationInputEvent({
      method: "item/agentMessage/delta",
      receivedAtMs: 456,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "OK",
      },
    })).toEqual({
      type: "item.agentMessage.delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "OK",
      receivedAtMs: 456,
    });
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
      params: { authMode: "chatgpt", planType: "ent26" },
    })).toEqual({
      type: "account.updated",
      authMode: "chatgpt",
      planType: "ent26",
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
      params: {
        threadId: null,
        message: "代理连接失败，TOKEN=warning-secret",
      },
    })).toEqual({
      type: "warning",
      threadId: null,
      message: "代理连接失败，TOKEN=[REDACTED]",
    });
  });

  it("preserves user-relevant Turn errors while redacting credentials", () => {
    expect(toConversationInputEvent({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "命令执行失败，API_KEY=turn-secret",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    })).toEqual({
      type: "turn.error",
      threadId: "thread-1",
      turnId: "turn-1",
      message: "命令执行失败，API_KEY=[REDACTED]",
      willRetry: false,
    });
    expect(toConversationInputEvent({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "failed",
          durationMs: 65_432,
          error: {
            message: "模型请求失败，Authorization: Bearer bearer-secret",
            codexErrorInfo: null,
            additionalDetails: "请检查代理配置",
          },
        },
      },
    })).toEqual({
      type: "turn.completed",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "failed",
      durationMs: 65_432,
      error: "模型请求失败，Authorization: Bearer [REDACTED] 请检查代理配置",
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
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
          durationMs: -1,
        },
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
