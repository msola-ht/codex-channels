import { describe, expect, it } from "vitest";

import type { OperationUpdate } from "../src/conversation-core/index.js";
import {
  ContextCompactionNotices,
  compactOperationDetail,
  operationMetadata,
  operationStatus,
  operationTitle,
  shouldDisplayOperation,
  redactOperationDetail,
} from "../src/surfaces/operation-presentation.js";

describe("shared operation presentation", () => {
  it("does not fabricate a start for completion-only history and scopes deduplication by target and item", () => {
    const notices = new ContextCompactionNotices();
    const event = { type: "operation.updated" as const,
      target: { surface: "feishu" as const, accountId: "account", conversationId: "chat" },
      threadId: "thread", turnId: "turn",
      operation: { itemId: "compact", kind: "contextCompaction" as const, status: "completed" as const } };
    expect(notices.accept(event)).toBe("上下文压缩已完成。");
    expect(notices.accept(event)).toBeNull();
    expect(notices.accept({ ...event, operation: { ...event.operation, status: "running" } })).toBeNull();
    expect(notices.accept({ ...event, target: { ...event.target, conversationId: "other" } })).toBe("上下文压缩已完成。");
    expect(notices.accept({ ...event, operation: { ...event.operation, itemId: "next", status: "running" } })).toBe("开始压缩上下文…");
  });

  it.each(["running", "completed", "failed", "declined"] as const)("filters pure wait %s in compact mode while retaining errors", status => {
    const waiting = { ...operation("sleep"), status };
    expect(shouldDisplayOperation(waiting, "compact")).toBe(status === "failed" || status === "declined");
    expect(shouldDisplayOperation(waiting, "full")).toBe(true);
    expect(shouldDisplayOperation(waiting, "hidden")).toBe(false);
    expect(shouldDisplayOperation({ ...waiting, kind: "command" }, "compact")).toBe(true);
  });

  it("maps every operation kind to one shared title", () => {
    const titles = new Map<OperationUpdate["kind"], string>([
      ["command", "运行命令"],
      ["fileChange", "修改文件"],
      ["mcpTool", "调用 MCP 工具"],
      ["dynamicTool", "调用工具"],
      ["subagent", "子代理活动"],
      ["webSearch", "搜索网页"],
      ["imageView", "查看图片"],
      ["imageGeneration", "生成图片"],
      ["sleep", "暂停等待"],
      ["plan", "更新计划"],
      ["contextCompaction", "压缩上下文"],
      ["reviewMode", "进入审查模式"],
    ]);

    for (const [kind, title] of titles) {
      expect(operationTitle(operation(kind))).toBe(title);
    }
    expect(operationTitle(operation("reviewMode", "exited"))).toBe("退出审查模式");
    expect(operationTitle(operation("subagent", "spawnAgent"))).toBe("启动子代理");
    expect(operationTitle(operation("subagent", "sendMessage"))).toBe("向子代理发送消息");
    expect(operationTitle(operation("subagent", "followupTask"))).toBe("向子代理追加任务");
    expect(operationTitle(operation("subagent", "interruptAgent"))).toBe("中断子代理");
    expect(operationTitle(operation("subagent", "listAgents"))).toBe("查看子代理");
    expect(operationTitle(operation("subagent", "unknown"))).toBe("子代理活动");
  });

  it("maps operation statuses and optional metadata", () => {
    expect([
      operationStatus("running"),
      operationStatus("completed"),
      operationStatus("failed"),
      operationStatus("declined"),
    ]).toEqual(["运行中", "已完成", "失败", "已拒绝"]);
    expect(operationMetadata({
      ...operation("command"),
      durationMs: 125,
      exitCode: 0,
    })).toEqual(["125 ms", "exit 0"]);
    expect(operationMetadata({
      ...operation("command"),
      durationMs: 0,
      exitCode: 0,
    })).toEqual(["exit 0"]);
    expect(operationMetadata(operation("command"))).toEqual([]);
    expect(operationMetadata({
      ...operation("mcpTool"),
      readOnlyHint: true,
    })).toEqual(["上游标记只读"]);
    expect(operationMetadata({
      ...operation("mcpTool"),
      readOnlyHint: false,
    })).toEqual(["可能写入"]);
    expect(operationMetadata(operation("mcpTool"))).toEqual(["读写属性未知"]);
  });

  it("redacts and bounds compact details by Unicode characters", () => {
    expect(redactOperationDetail("TOKEN=[REDACTED]")).toBe("TOKEN=[已隐藏]");
    expect(compactOperationDetail(" git\nstatus\t--short ")).toBe("git status --short");

    const detail = compactOperationDetail("界".repeat(161));
    expect(Array.from(detail)).toHaveLength(160);
    expect(detail).toBe(`${"界".repeat(159)}…`);
  });

  it.each([true, false, undefined])("does not label computer actions with MCP readOnlyHint=%s", (readOnlyHint) => {
    expect(operationMetadata({
      ...operation("mcpTool", "computerUse"),
      ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
      durationMs: 125,
    })).toEqual(["125 ms"]);
  });

  it("shows local paths while preserving explicit sensitive placeholders", () => {
    const detail = [
      "/usr/bin/zsh -lc \"sed -n '1,400p'",
      "/root/.codex/skills/.system/imagegen/SKILL.md\"",
      "git -C /root/github/codex-channels status --short",
      "/Users/example/.codex-connect/credentials/private.bin",
      "TOKEN=[REDACTED]",
    ].join(" ");

    expect(redactOperationDetail(detail)).toBe(
      detail.replace("[REDACTED]", "[已隐藏]"),
    );
    expect(redactOperationDetail(detail)).toContain("/root/.codex");
    expect(redactOperationDetail(detail)).toContain(
      "/Users/example/.codex-connect",
    );
  });
});

function operation(
  kind: OperationUpdate["kind"],
  action?: string,
): OperationUpdate {
  return {
    itemId: "operation-1",
    kind,
    ...(action === undefined ? {} : { action }),
    status: "running",
  };
}
