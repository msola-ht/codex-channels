import { describe, expect, it } from "vitest";

import {
  isCriticalOutputEvent,
  type OutputEvent,
} from "../src/conversation-core/index.js";
import {
  isSheddableBacklogEvent,
  resolveSurfaceDelivery,
  surfaceDeliveryCoalesceKey,
} from "../src/surfaces/index.js";
import { isWeixinWindowEvent } from "../src/surfaces/delivery-policy.js";

const target = {
  surface: "telegram",
  accountId: "account",
  conversationId: "chat",
} as const;

/**
 * 每个 OutputEvent 变体都必须被明确归类：Record 键由联合类型约束，
 * 新增事件类型时本文件会编译失败，避免投递策略悄悄落后于协议。
 */
const eventsByType = {
  "turn.started": { type: "turn.started", target, threadId: "thread", turnId: "turn" },
  "user.message": {
    type: "user.message",
    target,
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    text: "输入",
  },
  "text.delta": {
    type: "text.delta",
    target,
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    text: "增量",
    phase: "commentary",
  },
  "text.completed": {
    type: "text.completed",
    target,
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    text: "完成",
    phase: "final_answer",
  },
  "operation.updated": {
    type: "operation.updated",
    target,
    threadId: "thread",
    turnId: "turn",
    operation: { itemId: "item", kind: "command", status: "running" },
  },
  "plan.updated": {
    type: "plan.updated",
    target,
    threadId: "thread",
    turnId: "turn",
    explanation: null,
    steps: [{ step: "步骤", status: "pending" }],
  },
  "subagent.spawned": {
    type: "subagent.spawned",
    target,
    threadId: "thread",
    turnId: "turn",
    agentThreadId: "agent-thread",
    agentPath: "/root/agent",
  },
  "subagent.contacted": {
    type: "subagent.contacted",
    target,
    threadId: "thread",
    turnId: "turn",
    agentThreadId: "agent-thread",
    agentPath: "/root/agent",
  },
  "subagent.completed": {
    type: "subagent.completed",
    target,
    parentThreadId: "thread",
    agentThreadId: "agent-thread",
    agentPath: "/root/agent",
    status: "completed",
    metricsStatus: "available",
    model: null,
    modelProvider: null,
    reasoningEffort: null,
    requestCount: 0,
    unsuccessfulRequestCount: 0,
    inputTokens: 0,
    cachedInputTokens: null,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  },
  "turn.completed": {
    type: "turn.completed",
    target,
    threadId: "thread",
    turnId: "turn",
    status: "completed",
  },
  "thread.status": {
    type: "thread.status",
    target,
    threadId: "thread",
    status: "idle",
  },
  "thread.name": { type: "thread.name", target, threadId: "thread", name: null },
  "thread.availability": {
    type: "thread.availability",
    target,
    threadId: "thread",
    availability: "available",
  },
  "turn.reasoning": {
    type: "turn.reasoning",
    target,
    threadId: "thread",
    turnId: "turn",
    summary: "思考中",
    elapsedMs: 1_000,
  },
  "connection.lost": {
    type: "connection.lost",
    target,
    threadId: "thread",
    message: "连接断开",
  },
  "connection.restored": {
    type: "connection.restored",
    target,
    threadId: "thread",
    message: "连接恢复",
  },
  "account.updated": {
    type: "account.updated",
    target,
    authMode: "chatgpt",
    planType: "pro",
  },
  "account.rateLimits.updated": {
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
  "mcp.status.updated": {
    type: "mcp.status.updated",
    target,
    threadId: "thread",
    name: "server",
    status: "ready",
    error: null,
    failureReason: null,
  },
  "mcp.oauth.completed": {
    type: "mcp.oauth.completed",
    target,
    threadId: "thread",
    name: "server",
    success: true,
    error: null,
  },
  warning: { type: "warning", target, message: "空闲告警", globalIdle: true },
  "conversation.idle.released": {
    type: "conversation.idle.released",
    target,
    threadId: "thread",
    minutes: 10,
  },
} satisfies Record<OutputEvent["type"], OutputEvent>;

const allEvents = Object.values(eventsByType);

describe("resolveSurfaceDelivery", () => {
  it("assigns every OutputEvent variant a disposition for each Surface", () => {
    for (const event of allEvents) {
      for (const surface of ["telegram", "feishu", "weixin"]) {
        const decision = resolveSurfaceDelivery(surface, event);
        expect(["deliver", "coalesce", "ignore"]).toContain(decision.disposition);
        if (decision.disposition === "coalesce") {
          expect(decision.coalesceKey).toBeTypeOf("string");
        }
      }
    }
  });

  it("lets only the WeChat reply-window whitelist through", () => {
    const delivered = allEvents
      .filter((event) => isWeixinWindowEvent(event))
      .map((event) => event.type)
      .sort();
    expect(delivered).toEqual(
      [
        "conversation.idle.released",
        "text.completed",
        "turn.completed",
        "turn.started",
        "warning",
      ].sort(),
    );
  });

  it("keeps reasoning and non-final copy out of the WeChat window budget", () => {
    expect(
      isWeixinWindowEvent({
        type: "warning",
        target,
        message: "普通告警",
      }),
    ).toBe(false);
    expect(
      isWeixinWindowEvent({
        type: "warning",
        target,
        message: "空闲告警",
        globalIdle: true,
      }),
    ).toBe(true);
    expect(
      isWeixinWindowEvent({
        type: "text.completed",
        target,
        threadId: "thread",
        turnId: "turn",
        itemId: "item",
        text: "过程",
        phase: "commentary",
      }),
    ).toBe(false);
    expect(
      isWeixinWindowEvent({
        type: "text.completed",
        target,
        threadId: "thread",
        turnId: "turn",
        itemId: "item",
        text: "结果",
        phase: "final_answer",
      }),
    ).toBe(true);
    expect(
      resolveSurfaceDelivery("weixin", eventsByType["turn.reasoning"]),
    ).toEqual({ disposition: "ignore", critical: false });
  });

  it("keeps the reasoning stream critical while coalescing it per Turn", () => {
    const reasoning = eventsByType["turn.reasoning"];
    expect(isCriticalOutputEvent(reasoning)).toBe(true);
    for (const surface of ["telegram", "feishu"]) {
      expect(resolveSurfaceDelivery(surface, reasoning)).toEqual({
        disposition: "coalesce",
        critical: true,
        coalesceKey: surfaceDeliveryCoalesceKey(reasoning),
      });
    }
    expect(surfaceDeliveryCoalesceKey(reasoning)).toBe("reasoning:thread:turn:0");
    expect(surfaceDeliveryCoalesceKey(reasoning, 2)).toBe("reasoning:thread:turn:2");
    expect(surfaceDeliveryCoalesceKey(eventsByType["turn.completed"], 3)).toBeUndefined();
  });

  it("tracks criticality from the shared predicate for non-reasoning output", () => {
    expect(resolveSurfaceDelivery("telegram", eventsByType["text.delta"])).toEqual({
      disposition: "deliver",
      critical: false,
    });
    expect(
      resolveSurfaceDelivery("telegram", eventsByType["turn.completed"]),
    ).toEqual({ disposition: "deliver", critical: true });
    expect(
      resolveSurfaceDelivery("feishu", eventsByType["plan.updated"]),
    ).toEqual({ disposition: "deliver", critical: false });
    expect(
      resolveSurfaceDelivery(
        "feishu",
        eventsByType["operation.updated"],
      ),
    ).toEqual({ disposition: "deliver", critical: false });
  });
});

describe("isSheddableBacklogEvent", () => {
  it("never sheds results, errors or completion notices", () => {
    const retained = [
      "text.completed",
      "operation.updated",
      "subagent.completed",
      "turn.completed",
      "mcp.oauth.completed",
      "warning",
      "conversation.idle.released",
    ] as const;
    for (const type of retained) {
      expect(isSheddableBacklogEvent(eventsByType[type])).toBe(false);
    }
  });

  it("sheds process, status and lifecycle notices", () => {
    const sheddable = [
      "turn.reasoning",
      "user.message",
      "thread.status",
      "thread.name",
      "thread.availability",
      "connection.lost",
      "connection.restored",
      "account.updated",
      "account.rateLimits.updated",
      "mcp.status.updated",
    ] as const;
    for (const type of sheddable) {
      expect(isSheddableBacklogEvent(eventsByType[type])).toBe(true);
    }
  });
});

it.each(["feishu", "telegram", "weixin"] as const)("protects compaction start and completion from shedding for %s", (surface) => {
  for (const status of ["running", "completed"] as const) {
    const event: OutputEvent = { type: "operation.updated", target: { ...target, surface },
      threadId: "thread", turnId: "turn", operation: { itemId: "compact", kind: "contextCompaction", status } };
    expect(resolveSurfaceDelivery(surface, event)).toEqual({ disposition: "deliver", critical: true });
    expect(isCriticalOutputEvent(event)).toBe(true);
    expect(isSheddableBacklogEvent(event)).toBe(false);
  }
});
