import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

import { renderTelegramCommandResult } from "../src/surfaces/telegram/command-renderer.js";

describe("Telegram command renderer", () => {
  it("renders expanded shared notices through the safe HTML panel path", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "notice",
        text: "Thread：<unsafe>",
        detail: "expanded",
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
        kind: "notice",
        text: "已停止",
        detail: "brief",
      },
    );

    expect(reply).toHaveBeenCalledWith("已停止");
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
});
