import { describe, expect, it } from "vitest";

import type { OperationUpdate } from "../src/conversation-core/index.js";
import {
  formatWeixinOperation,
} from "../src/surfaces/weixin/index.js";

describe("formatWeixinOperation", () => {
  it("redacts placeholders and neutralizes Markdown control characters", () => {
    const text = formatWeixinOperation({
      ...operationFixture,
      detail: "[REDACTED] `code` *bold* _under_ ~strike~ # title > quote [link]",
    });

    expect(text).toContain("［已隐藏］");
    expect(text).not.toContain("[REDACTED]");
    for (const control of ["`", "*", "_", "~", "#", ">", "[", "]"]) {
      expect(text).not.toContain(control);
    }
    expect(text).toContain("耗时：125毫秒");
  });

  it("bounds compact detail and keeps it on one line", () => {
    const text = formatWeixinOperation(
      {
        ...operationFixture,
        detail: `first line\n${"测".repeat(180)}`,
      },
      "compact",
    );

    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("运行命令 · 已完成 · exit 0");
    expect(text).toContain("first line ");
    expect(text).toContain("… · 耗时：125毫秒");
  });

  it("shows the MCP read-only hint", () => {
    expect(formatWeixinOperation({
      itemId: "mcp-read",
      kind: "mcpTool",
      detail: "github.get_issue",
      status: "completed",
      readOnlyHint: true,
    })).toContain("调用 MCP 工具 · 已完成 · 上游标记只读");
  });
});

const operationFixture: OperationUpdate = {
  itemId: "command",
  kind: "command",
  status: "completed",
  exitCode: 0,
  durationMs: 125,
};
