import { describe, expect, it, vi } from "vitest";

import {
  CollaborationModeSelectionService,
  type CollaborationModeQueryPort,
} from "../src/application/index.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import type { SessionRouter } from "../src/session-routing/index.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "100",
};

function queryPort(): CollaborationModeQueryPort {
  return {
    listCollaborationModes: vi.fn(async () => [
      { name: "Default", mode: "default" as const, model: null, effort: null },
      { name: "Plan", mode: "plan" as const, model: null, effort: "medium" },
    ]),
  };
}

describe("CollaborationModeSelectionService", () => {
  it("builds the official Plan preset for the next Turn and marks it applied", async () => {
    const updateCollaborationMode = vi.fn();
    const router = {
      current: () => ({
        target,
        workspaceId: "main",
        threadId: "thread-1",
        sessionId: "session-1",
      }),
      modelSettings: () => ({
        model: "gpt-5.6-sol",
        effort: "high",
        serviceTier: "default",
        collaborationMode: "default" as const,
      }),
      updateCollaborationMode,
    } as unknown as SessionRouter;
    const service = new CollaborationModeSelectionService(
      queryPort(),
      router,
      {
        state: async () => ({
          models: [],
          model: "gpt-5.6-sol",
          effort: "high",
          serviceTier: "default",
          modelPending: false,
          effortPending: false,
          serviceTierPending: false,
        }),
      } as unknown as ModelSelectionService,
    );

    await expect(service.toggle(target)).resolves.toEqual({
      mode: "plan",
      pending: true,
    });
    expect(service.turnOverride(target)).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5.6-sol",
        effort: "medium",
        developerInstructions: null,
      },
    });

    service.markApplied(target);
    expect(updateCollaborationMode).toHaveBeenCalledWith("thread-1", "plan");
    expect(service.status(target)).toEqual({ mode: "default", pending: false });
  });

  it("fails closed when the locked App Server does not return a requested preset", async () => {
    const service = new CollaborationModeSelectionService(
      { listCollaborationModes: async () => [] },
      { modelSettings: () => undefined } as unknown as SessionRouter,
      {
        state: async () => ({
          models: [],
          model: "gpt-5.6-sol",
          effort: "medium",
        }),
      } as unknown as ModelSelectionService,
    );

    await expect(service.select(target, "plan")).rejects.toMatchObject({
      code: "collaboration-mode.unsupported",
    });
  });
});
