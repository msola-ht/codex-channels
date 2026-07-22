import { describe, expect, it } from "vitest";

import { parseOperationUpdate, sanitizeOperationText } from "../src/conversation-core/operation.js";

describe("operation normalization", () => {
  it.each([
    [{ type: "mcpToolCall", id: "1", server: "github", tool: "search", status: "completed" }, "mcpTool", "github.search", undefined],
    [{ type: "dynamicToolCall", id: "2", namespace: "browser", tool: "open", status: "completed" }, "dynamicTool", "browser.open", undefined],
    [{ type: "webSearch", id: "3", query: "Codex App Server" }, "webSearch", "Codex App Server", undefined],
    [{ type: "imageView", id: "4", path: "/tmp/image.png" }, "imageView", "/tmp/image.png", undefined],
    [{ type: "collabAgentToolCall", id: "5", tool: "spawnAgent", status: "completed" }, "subagent", undefined, "spawnAgent"],
    [{ type: "contextCompaction", id: "6" }, "contextCompaction", undefined, undefined],
  ])("normalizes supported item %s", (item, kind, detail, action) => {
    expect(parseOperationUpdate(item, "completed")).toMatchObject({
      itemId: item.id,
      kind,
      status: "completed",
      ...(detail ? { detail } : {}),
      ...(action ? { action } : {}),
    });
  });

  it("maps failed and declined item states", () => {
    expect(parseOperationUpdate(
      { type: "commandExecution", id: "1", command: "false", status: "failed" },
      "completed",
    )?.status).toBe("failed");
    expect(parseOperationUpdate(
      { type: "fileChange", id: "2", changes: [], status: "declined" },
      "completed",
    )?.status).toBe("declined");
  });

  it("redacts common credential forms without exposing their values", () => {
    const sanitized = sanitizeOperationText([
      "TELEGRAM_BOT_TOKEN=bot-secret",
      "AWS_ACCESS_KEY_ID=access-secret",
      "--password pass-secret",
      "Authorization: Bearer bearer-secret",
      "Cookie: cookie-secret",
      "token positional-secret",
      "curl -u user:basic-secret https://example.com",
      "https://user:url-secret@example.com",
    ].join(" "));

    expect(sanitized).not.toMatch(/bot-secret|access-secret|pass-secret|bearer-secret|cookie-secret|positional-secret|basic-secret|url-secret/);
    expect(sanitized.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(8);
  });
});
