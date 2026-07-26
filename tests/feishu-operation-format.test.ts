import { describe, expect, it } from "vitest";

import type { OperationUpdate } from "../src/conversation-core/index.js";
import { formatFeishuOperationLog } from "../src/surfaces/feishu/index.js";

describe("Feishu operation log formatter", () => {
  it("shows the concrete sanitized operation details and latest status", () => {
    const records = new Map<string, OperationUpdate>([
      ["command-1", {
        itemId: "command-1",
        kind: "command",
        detail: "TOKEN=[REDACTED] git status --short",
        status: "completed",
        durationMs: 125,
        exitCode: 0,
      }],
      ["file-1", {
        itemId: "file-1",
        kind: "fileChange",
        detail: "src/main.ts、README.md",
        status: "running",
      }],
    ]);

    expect(formatFeishuOperationLog({
      order: ["command-1", "file-1"],
      records,
      omittedCount: 0,
    })).toBe([
      "**执行进度**",
      "",
      "**运行命令 · 已完成** · 125 ms · exit 0",
      "```shell",
      "TOKEN=[已隐藏] git status --short",
      "```",
      "",
      "**修改文件 · 运行中**",
      "具体内容：`src/main.ts、README.md`",
    ].join("\n"));
  });

  it("shows the exact MCP server and tool name", () => {
    expect(formatFeishuOperationLog({
      order: ["mcp-1"],
      records: new Map([["mcp-1", {
        itemId: "mcp-1",
        kind: "mcpTool",
        detail: "codex_apps.list_mcp_resources",
        status: "completed",
        durationMs: 2_623,
      }]]),
      omittedCount: 0,
    })).toContain(
      "**调用 MCP 工具 · 已完成** · 2623 ms\n"
      + "具体内容：`codex_apps.list_mcp_resources`",
    );
  });
});
