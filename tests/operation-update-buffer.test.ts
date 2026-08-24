import { describe, expect, it } from "vitest";

import type {
  OperationUpdate,
  OutputEvent,
} from "../src/conversation-core/index.js";
import {
  operationSummaryGroups,
  OperationUpdateBuffer,
} from "../src/surfaces/operation-update-buffer.js";

describe("OperationUpdateBuffer", () => {
  it("buffers successful query operations once per item and summarizes them", () => {
    const buffer = new OperationUpdateBuffer<string>();
    const first = operation("mcp-1", "mcpTool", "completed", 100);

    expect(buffer.accept(operationEvent(first), "chat")).toBe(true);
    expect(buffer.accept(operationEvent(first), "chat")).toBe(true);
    expect(buffer.accept(operationEvent(
      operation("search-1", "webSearch", "completed", 250),
    ), "chat")).toBe(true);

    const buffered = buffer.flush(turnCompleted());
    expect(buffered?.target).toBe("chat");
    expect(buffered?.summary.records).toHaveLength(2);
    expect(buffered?.summary.totalDurationMs).toBe(350);
    expect(buffered && operationSummaryGroups(buffered.summary)).toEqual([
      {
        label: "MCP 工具",
        count: 1,
        details: [],
        omittedDetailCount: 0,
      },
      {
        label: "网页搜索",
        count: 1,
        details: [],
        omittedDetailCount: 0,
      },
    ]);
    expect(buffer.flush(turnCompleted())).toBeNull();
  });

  it("suppresses running query frames but leaves failures and commands immediate", () => {
    const buffer = new OperationUpdateBuffer<string>();

    expect(buffer.accept(operationEvent(
      operation("mcp-1", "mcpTool", "running"),
    ), "chat")).toBe(true);
    expect(buffer.accept(operationEvent(
      operation("mcp-1", "mcpTool", "failed"),
    ), "chat")).toBe(false);
    expect(buffer.accept(operationEvent(
      operation("command-1", "command", "completed"),
    ), "chat")).toBe(false);
    expect(buffer.flush(turnCompleted())).toBeNull();
  });

  it("falls back to immediate delivery instead of dropping terminal updates at capacity", () => {
    const buffer = new OperationUpdateBuffer<string>();
    for (let index = 0; index < 100; index += 1) {
      expect(buffer.accept(operationEvent(
        operation(`mcp-${index}`, "mcpTool", "completed"),
      ), "chat")).toBe(true);
    }

    expect(buffer.accept(operationEvent(
      operation("mcp-overflow", "mcpTool", "completed"),
    ), "chat")).toBe(false);
    expect(buffer.flush(turnCompleted())?.summary.records).toHaveLength(100);
  });

  it("drains buffered terminal updates with their delivery targets", () => {
    const buffer = new OperationUpdateBuffer<string>();
    buffer.accept(operationEvent(
      operation("mcp-1", "mcpTool", "completed"),
      "one",
    ), "chat-one");
    buffer.accept(operationEvent(
      operation("mcp-2", "mcpTool", "completed"),
      "two",
    ), "chat-two");

    expect(buffer.drain().map(({ target }) => target)).toEqual([
      "chat-one",
      "chat-two",
    ]);
    expect(buffer.drain()).toEqual([]);
  });

  it("keeps query summaries buffered through commentary and flushes before final text", () => {
    const buffer = new OperationUpdateBuffer<string>();
    buffer.accept(operationEvent(
      operation("mcp-1", "mcpTool", "completed"),
    ), "chat");

    expect(buffer.flush(textCompleted("commentary"))).toBeNull();
    expect(buffer.flush(textCompleted("final_answer"))?.target).toBe("chat");
    expect(buffer.flush(turnCompleted())).toBeNull();
  });
});

const target = {
  surface: "telegram" as const,
  accountId: "default",
  conversationId: "chat",
};

function operationEvent(
  value: OperationUpdate,
  turnId = "turn",
): Extract<OutputEvent, { type: "operation.updated" }> {
  return {
    type: "operation.updated",
    target,
    threadId: "thread",
    turnId,
    operation: value,
  };
}

function textCompleted(
  phase: "commentary" | "final_answer",
): Extract<OutputEvent, { type: "text.completed" }> {
  return {
    type: "text.completed",
    target,
    threadId: "thread",
    turnId: "turn",
    itemId: "text",
    text: "text",
    phase,
  };
}

function turnCompleted(): Extract<OutputEvent, { type: "turn.completed" }> {
  return {
    type: "turn.completed",
    target,
    threadId: "thread",
    turnId: "turn",
    status: "completed",
  };
}

function operation(
  itemId: string,
  kind: OperationUpdate["kind"],
  status: OperationUpdate["status"],
  durationMs?: number,
): OperationUpdate {
  return {
    itemId,
    kind,
    status,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}
