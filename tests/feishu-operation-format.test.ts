import { describe, expect, it } from "vitest";

import type { OperationUpdate } from "../src/conversation-core/index.js";
import { formatFeishuOperation } from "../src/surfaces/feishu/index.js";
import { renderFeishuComputerUseCard } from "../src/surfaces/feishu/operation-format.js";

describe("Feishu operation log formatter", () => {
  it.each(["compact", "full"] as const)("renders an updatable CUA card with safe details and duration in %s mode", (display) => {
    const card = renderFeishuComputerUseCard({
      itemId: "cua-1", kind: "mcpTool", action: "computerUse", status: "completed",
      detail: '查看 <at id="all">所有人</at> TOKEN=[REDACTED] · cua_repl.js',
      readOnlyHint: true, durationMs: 1_720,
    }, display);
    expect(card).toMatchObject({
      schema: "2.0", config: { update_multi: true, wide_screen_mode: true },
      header: { template: "green", title: { content: "电脑与浏览器操作 · 已完成" } },
    });
    const content = JSON.stringify(card.body);
    expect(content).toContain("1.72 s");
    expect(content).toContain("TOKEN=[已隐藏]");
    expect(content).toContain("&lt;at");
    expect(content).not.toMatch(/<at|上游标记只读/);
    expect(formatFeishuOperation({ itemId: "cua-1", kind: "mcpTool", action: "computerUse", status: "running", readOnlyHint: true }, display))
      .toBe("**电脑与浏览器操作 · 运行中**");
  });

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
      "**耗时：** 125 ms",
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
      "**调用 MCP 工具 · 已完成** · 读写属性未知\n"
      + "具体内容：`codex_apps.list_mcp_resources`\n\n"
      + "---\n"
      + "**耗时：** 2.62 s",
    );
  });

  it("shows MCP tool capability hints without changing the outcome", () => {
    expect(formatFeishuOperation({
      itemId: "mcp-write",
      kind: "mcpTool",
      detail: "github.create_issue",
      status: "completed",
      readOnlyHint: false,
    })).toContain("已完成** · 可能写入");
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
      + "**耗时：** 125 ms",
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

    expect(text).toContain("/root/.codex/skills/imagegen/SKILL.md");
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
