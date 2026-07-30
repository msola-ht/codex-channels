import { describe, expect, it } from "vitest";

import type { OperationUpdate } from "../src/conversation-core/index.js";
import {
  operationSummaryRows,
  OperationUpdateBuffer,
} from "../src/surfaces/operation-update-buffer.js";

describe("OperationUpdateBuffer", () => {
  it("buffers successful query operations once per item and summarizes them", () => {
    const buffer = new OperationUpdateBuffer<string>();
    const first = operation("mcp-1", "mcpTool", "completed", 100);

    expect(buffer.accept("thread:turn", first, "chat")).toBe(true);
    expect(buffer.accept("thread:turn", first, "chat")).toBe(true);
    expect(buffer.accept(
      "thread:turn",
      operation("search-1", "webSearch", "completed", 250),
      "chat",
    )).toBe(true);

    const buffered = buffer.take("thread:turn");
    expect(buffered?.target).toBe("chat");
    expect(buffered?.summary.records).toHaveLength(2);
    expect(buffered?.summary.totalDurationMs).toBe(350);
    expect(buffered && operationSummaryRows(buffered.summary)).toEqual([
      "MCP 工具：1 次",
      "网页搜索：1 次",
    ]);
    expect(buffer.take("thread:turn")).toBeNull();
  });

  it("suppresses running query frames but leaves failures and commands immediate", () => {
    const buffer = new OperationUpdateBuffer<string>();

    expect(buffer.accept(
      "thread:turn",
      operation("mcp-1", "mcpTool", "running"),
      "chat",
    )).toBe(true);
    expect(buffer.accept(
      "thread:turn",
      operation("mcp-1", "mcpTool", "failed"),
      "chat",
    )).toBe(false);
    expect(buffer.accept(
      "thread:turn",
      operation("command-1", "command", "completed"),
      "chat",
    )).toBe(false);
    expect(buffer.take("thread:turn")).toBeNull();
  });

  it("falls back to immediate delivery instead of dropping terminal updates at capacity", () => {
    const buffer = new OperationUpdateBuffer<string>();
    for (let index = 0; index < 100; index += 1) {
      expect(buffer.accept(
        "thread:turn",
        operation(`mcp-${index}`, "mcpTool", "completed"),
        "chat",
      )).toBe(true);
    }

    expect(buffer.accept(
      "thread:turn",
      operation("mcp-overflow", "mcpTool", "completed"),
      "chat",
    )).toBe(false);
    expect(buffer.take("thread:turn")?.summary.records).toHaveLength(100);
  });

  it("drains buffered terminal updates with their delivery targets", () => {
    const buffer = new OperationUpdateBuffer<string>();
    buffer.accept(
      "thread:one",
      operation("mcp-1", "mcpTool", "completed"),
      "chat-one",
    );
    buffer.accept(
      "thread:two",
      operation("mcp-2", "mcpTool", "completed"),
      "chat-two",
    );

    expect(buffer.drain().map(({ target }) => target)).toEqual([
      "chat-one",
      "chat-two",
    ]);
    expect(buffer.drain()).toEqual([]);
  });
});

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
