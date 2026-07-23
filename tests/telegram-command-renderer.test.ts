import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

import { renderTelegramCommandResult } from "../src/surfaces/telegram/command-renderer.js";
import { formatMcpStatusUpdate } from "../src/surfaces/telegram/format.js";

describe("Telegram command renderer", () => {
  it("renders expanded shared notices through the safe HTML panel path", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: { type: "thread.resumed", threadId: "<unsafe>" },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("&lt;unsafe&gt;"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("keeps brief notices as native platform text", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: { type: "turn.stop-requested", stopped: true },
      },
    );

    expect(reply).toHaveBeenCalledWith("已请求停止当前任务。");
  });

  it("confirms queued follow-ups and explains their in-memory lifetime", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: { type: "turn.follow-up-queued", position: 2 },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      "已排到下一 Turn，当前第 2 条。队列仅保存在内存，Gateway 重启会清空。",
    );
  });

  it("uses the dedicated diff renderer for artifact results", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "artifacts",
        view: "diff",
        artifacts: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff: "diff --git a/a.ts b/a.ts\n+const value = 1;",
        },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("diff"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("hides opaque MCP startup errors", () => {
    const text = formatMcpStatusUpdate({
      threadId: "thread-1",
      name: "docs",
      status: "failed",
      error: "request failed at /bot123456789:opaque-secret/file",
      failureReason: null,
    });

    expect(text).toContain("Gateway 已隐藏上游错误详情");
    expect(text).not.toContain("opaque-secret");
  });
});
