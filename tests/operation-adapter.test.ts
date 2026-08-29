import { describe, expect, it } from "vitest";

import {
  sanitizeOperationText,
  toOperationUpdate,
} from "../src/codex-client/index.js";

describe("operation normalization", () => {
  it.each([
    [{ type: "mcpToolCall", id: "1", server: "github", tool: "search", status: "completed", readOnlyHint: true }, "mcpTool", "github.search", undefined],
    [{ type: "dynamicToolCall", id: "2", namespace: "browser", tool: "open", status: "completed" }, "dynamicTool", "browser.open", undefined],
    [{ type: "webSearch", id: "3", query: "Codex App Server" }, "webSearch", "Codex App Server", undefined],
    [{ type: "imageView", id: "4", path: "/tmp/image.png" }, "imageView", "/tmp/image.png", undefined],
    [{ type: "collabAgentToolCall", id: "5", tool: "spawnAgent", status: "completed" }, "subagent", undefined, "spawnAgent"],
    [{ type: "contextCompaction", id: "6" }, "contextCompaction", undefined, undefined],
  ])("normalizes supported item %s", (item, kind, detail, action) => {
    expect(toOperationUpdate(item, "completed")).toMatchObject({
      itemId: item.id,
      kind,
      status: "completed",
      ...(detail ? { detail } : {}),
      ...(action ? { action } : {}),
    });
  });

  it("preserves the MCP read-only hint without treating it as an outcome", () => {
    expect(toOperationUpdate({
      type: "mcpToolCall",
      id: "mcp-read",
      server: "github",
      tool: "get_issue",
      status: "completed",
      readOnlyHint: true,
    }, "completed")).toMatchObject({ readOnlyHint: true });
    expect(toOperationUpdate({
      type: "mcpToolCall",
      id: "mcp-write",
      server: "github",
      tool: "create_issue",
      status: "completed",
      readOnlyHint: false,
    }, "completed")).toMatchObject({ readOnlyHint: false });
  });

  it("maps failed and declined item states", () => {
    expect(toOperationUpdate(
      { type: "commandExecution", id: "1", command: "false", status: "failed" },
      "completed",
    )?.status).toBe("failed");
    expect(toOperationUpdate(
      { type: "fileChange", id: "2", changes: [], status: "declined" },
      "completed",
    )?.status).toBe("declined");
    expect(toOperationUpdate(
      { type: "collabAgentToolCall", id: "3", tool: "wait", status: "interrupted" },
      "completed",
    )?.status).toBe("failed");
  });

  it("maps only the official generated-image saved path as an artifact", () => {
    expect(toOperationUpdate({
      type: "imageGeneration",
      id: "image",
      status: "completed",
      savedPath: "/private/generated/image.png",
      result: "private image body",
    }, "completed")).toEqual({
      itemId: "image",
      kind: "imageGeneration",
      status: "completed",
      imagePath: "/private/generated/image.png",
    });

    expect(toOperationUpdate({
      type: "imageGeneration",
      id: "limited-image",
      status: "failed",
      failure: {
        type: "usageLimitExceeded",
        limitId: "image-generation",
        resetsAt: null,
      },
    }, "completed")).toEqual({
      itemId: "limited-image",
      kind: "imageGeneration",
      status: "failed",
      detail: "图片生成额度已用尽",
    });

    expect(toOperationUpdate({
      type: "imageView",
      id: "view",
      path: "/private/uploads/inbound.png",
    }, "completed")).not.toHaveProperty("imagePath");
  });

  it("redacts common credential forms without exposing their values", () => {
    const cases = [
      ["TELEGRAM_BOT_TOKEN=bot-secret", /bot-secret/],
      ["AWS_ACCESS_KEY_ID=access-secret", /access-secret/],
      ["--password pass-secret", /pass-secret/],
      ["Authorization: Bearer bearer-secret", /bearer-secret/],
      ["Authorization: Basic basic-header-secret", /basic-header-secret/],
      ["Authorization: custom-header-secret", /custom-header-secret/],
      [
        "Cookie: session=cookie-secret; preference=cookie-preference-secret\n",
        /cookie-secret|cookie-preference-secret/,
      ],
      ["Set-Cookie: session=set-cookie-secret; HttpOnly\n", /set-cookie-secret/],
      ["token positional-secret", /positional-secret/],
      ["curl -u user:basic-secret https://example.com", /basic-secret/],
      ["https://user:url-secret@example.com", /url-secret/],
      [
        "request failed at /bot123456789:AAExampleTelegramBotToken123456789/file",
        /AAExampleTelegramBotToken/,
      ],
    ] as const;

    for (const [value, secret] of cases) {
      const sanitized = sanitizeOperationText(value);
      expect(sanitized).toContain("[REDACTED]");
      expect(sanitized).not.toMatch(secret);
    }
  });

  it("limits sanitized upstream text to 320 Unicode characters", () => {
    const sanitized = sanitizeOperationText("错".repeat(400));

    expect(Array.from(sanitized)).toHaveLength(320);
    expect(sanitized.endsWith("…")).toBe(true);
  });
});
