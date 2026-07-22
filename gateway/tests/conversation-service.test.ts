import { describe, expect, it, vi } from "vitest";

import { ConversationService } from "../src/application/conversation-service.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { CodexAppServerClient } from "../src/codex-client/client.js";
import type { ConversationCore } from "../src/conversation-core/core.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, conversationId: "100" };
const main = { id: "main", name: "Main", cwd: "/workspace/main" };
const other = { id: "other", name: "Other", cwd: "/workspace/other" };

describe("ConversationService model selection", () => {
  it("passes pending model settings to the next turn and clears them after success", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turn: { id: "turn-1" } });
    const markApplied = vi.fn();
    const markTurnStarted = vi.fn();
    const service = new ConversationService(
      { startTurn } as unknown as CodexAppServerClient,
      {
        ensure: async () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => main,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined, markTurnStarted } as unknown as ConversationCore,
      {
        turnOverrides: () => ({ model: "gpt-selected", effort: "high" }),
        markApplied,
      } as unknown as ModelSelectionService,
    );

    await service.submit(target, "测试输入");

    expect(startTurn).toHaveBeenCalledWith(
      "thread-1",
      "测试输入",
      expect.stringMatching(/^codex_tg_gateway:/),
      "/workspace/main",
      { model: "gpt-selected", effort: "high" },
    );
    expect(markApplied).toHaveBeenCalledWith(target);
    expect(markTurnStarted).toHaveBeenCalledWith(target, "thread-1", "turn-1");
  });

  it("keeps pending settings when selecting the same workspace", async () => {
    const clear = vi.fn();
    const service = workspaceService(main, async () => main, clear);

    await service.selectWorkspace(target, "main");

    expect(clear).not.toHaveBeenCalled();
  });

  it("only clears pending settings after a workspace switch succeeds", async () => {
    const clear = vi.fn();
    const successful = workspaceService(main, async () => other, clear);

    await successful.selectWorkspace(target, "other");
    expect(clear).toHaveBeenCalledWith(target);

    clear.mockClear();
    const failed = workspaceService(main, async () => {
      throw new Error("switch failed");
    }, clear);
    await expect(failed.selectWorkspace(target, "other")).rejects.toThrow("switch failed");
    expect(clear).not.toHaveBeenCalled();
  });
});

function workspaceService(
  current: typeof main,
  selectWorkspace: () => Promise<typeof main>,
  clear: ReturnType<typeof vi.fn>,
): ConversationService {
  return new ConversationService(
    {} as CodexAppServerClient,
    {
      workspace: () => current,
      resolveWorkspace: (selector: string) => selector === "other" ? other : main,
      selectWorkspace,
    } as unknown as SessionRouter,
    { activeTurn: () => undefined } as unknown as ConversationCore,
    { clear } as unknown as ModelSelectionService,
  );
}
