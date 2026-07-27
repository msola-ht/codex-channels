import { describe, expect, it } from "vitest";

import type { OperationUpdate } from "../src/conversation-core/index.js";
import {
  compactOperationDetail,
  operationMetadata,
  operationStatus,
  operationTitle,
  redactOperationDetail,
} from "../src/surfaces/operation-presentation.js";

describe("shared operation presentation", () => {
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
      ["sleep", "等待"],
      ["plan", "更新计划"],
      ["contextCompaction", "压缩上下文"],
      ["reviewMode", "进入审查模式"],
    ]);

    for (const [kind, title] of titles) {
      expect(operationTitle(operation(kind))).toBe(title);
    }
    expect(operationTitle(operation("reviewMode", "exited"))).toBe("退出审查模式");
    expect(operationTitle(operation("subagent", "spawnAgent"))).toBe("启动子代理");
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
  });

  it("redacts and bounds compact details by Unicode characters", () => {
    expect(redactOperationDetail("TOKEN=[REDACTED]")).toBe("TOKEN=[已隐藏]");
    expect(compactOperationDetail(" git\nstatus\t--short ")).toBe("git status --short");

    const detail = compactOperationDetail("界".repeat(161));
    expect(Array.from(detail)).toHaveLength(160);
    expect(detail).toBe(`${"界".repeat(159)}…`);
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
