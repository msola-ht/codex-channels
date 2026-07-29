import { describe, expect, it } from "vitest";

import type { OperationUpdate } from "../src/conversation-core/index.js";
import { formatFeishuOperation } from "../src/surfaces/feishu/index.js";

describe("Feishu operation log formatter", () => {
  it("shows the concrete sanitized operation details and latest status", () => {
    const record: OperationUpdate = {
      itemId: "command-1",
      kind: "command",
      detail: "TOKEN=[REDACTED] git status --short",
      status: "completed",
      durationMs: 125,
      exitCode: 0,
    };

    expect(formatFeishuOperation(record)).toBe([
      "**运行命令 · 已完成** · exit 0",
      "```shell",
      "TOKEN=[已隐藏] git status --short",
      "```",
      "",
      "---",
      "**耗时：** 125毫秒",
    ].join("\n"));
  });

  it("shows the exact MCP server and tool name", () => {
    expect(formatFeishuOperation({
      itemId: "mcp-1",
      kind: "mcpTool",
      detail: "codex_apps.list_mcp_resources",
      status: "completed",
      durationMs: 2_623,
    })).toContain(
      "**调用 MCP 工具 · 已完成**\n"
      + "具体内容：`codex_apps.list_mcp_resources`\n\n"
      + "---\n"
      + "**耗时：** 3秒",
    );
  });

  it("renders one-line details in compact mode", () => {
    expect(formatFeishuOperation({
      itemId: "command-1",
      kind: "command",
      detail: "git status --short\nsecond line",
      status: "completed",
      durationMs: 125,
      exitCode: 0,
    }, "compact")).toBe(
      "**运行命令 · 已完成** · exit 0 · `git status --short second line`\n\n"
      + "---\n"
      + "**耗时：** 125毫秒",
    );
  });

  it("does not expose private Codex paths in command details", () => {
    const text = formatFeishuOperation({
      itemId: "command-1",
      kind: "command",
      detail: "/usr/bin/zsh -lc \"sed -n '1,400p' /root/.codex/skills/imagegen/SKILL.md\"",
      status: "completed",
      exitCode: 0,
    });

    expect(text).toContain("[内部路径]");
    expect(text).not.toContain("/root/.codex");
  });

  it("omits the duration footer when no positive duration is available", () => {
    expect(formatFeishuOperation({
      itemId: "command-1",
      kind: "command",
      detail: "git status --short",
      status: "completed",
      durationMs: 0,
      exitCode: 0,
    })).toBe([
      "**运行命令 · 已完成** · exit 0",
      "```shell",
      "git status --short",
      "```",
    ].join("\n"));
  });
});
