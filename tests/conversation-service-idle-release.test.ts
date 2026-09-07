import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  type ConversationQueryPort,
} from "../src/application/conversation-service.js";
import type { ConversationCore } from "../src/conversation-core/index.js";
import type { ConversationTransferPort } from "../src/application/conversation-service.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const binding = {
  target,
  workspaceId: "main",
  threadId: "thread-idle",
  sessionId: "session-idle",
};

function queryPort(): ConversationQueryPort {
  const unsupported = async (): Promise<never> => {
    throw new Error("测试未配置 ConversationQueryPort 方法");
  };
  return {
    listSkills: unsupported,
    resolveSkill: unsupported,
    listMcpServers: unsupported,
    listMcpServerDetails: unsupported,
    reloadMcpServers: unsupported,
    startMcpOAuthLogin: unsupported,
    readMcpResource: unsupported,
    listPlugins: unsupported,
    resolvePlugin: unsupported,
    accountUsage: unsupported,
    accountRateLimits: unsupported,
    accountThreadUsage: unsupported,
    listPermissionProfiles: unsupported,
  };
}

function createService({
  activeTurn,
  hasQueue = false,
  pendingInteraction = false,
  pendingSubagent = false,
  capturePreference,
  restorePreference,
  modelClear,
  collaborationClear,
  status = { type: "idle" },
  newSession,
}: {
  activeTurn?: unknown;
  hasQueue?: boolean;
  pendingInteraction?: boolean;
  pendingSubagent?: boolean;
  capturePreference?: ReturnType<typeof vi.fn>;
  restorePreference?: ReturnType<typeof vi.fn>;
  modelClear?: ReturnType<typeof vi.fn>;
  collaborationClear?: ReturnType<typeof vi.fn>;
  status?: { type: "idle" | "active" | "notLoaded" | "systemError" };
  newSession: ReturnType<typeof vi.fn>;
}): ConversationService {
  const router = {
    current: () => binding,
    readThread: async () => ({ status }),
    newSession,
    touchActivity: vi.fn(),
  } as unknown as SessionRouter;
  const transfers: ConversationTransferPort = {
    hasPendingInteraction: () => pendingInteraction,
    notifyTransferred: vi.fn(),
  };
  const models = {
    ...(capturePreference === undefined ? {} : { capturePreference }),
    ...(restorePreference === undefined ? {} : { restorePreference }),
    ...(modelClear === undefined ? {} : { clear: modelClear }),
  } as never;
  const collaborationModes = collaborationClear === undefined
    ? undefined
    : { clear: collaborationClear } as never;
  return new ConversationService(
    {} as never,
    router,
    { activeTurn: () => activeTurn } as unknown as ConversationCore,
    models,
    queryPort(),
    undefined,
    undefined,
    collaborationModes,
    transfers,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      listQueue: async () => ({
        items: hasQueue ? [{}] : [],
        nextCursor: null,
      }),
    } as never,
    undefined,
    undefined,
    pendingSubagent ? () => true : undefined,
  );
}

describe("ConversationService idle release", () => {
  it("releases an idle foreground binding through the router", async () => {
    const newSession = vi.fn(async () => undefined);
    const service = createService({ newSession });

    await expect(service.releaseIdle(target)).resolves.toEqual({
      status: "released",
      threadId: binding.threadId,
    });
    expect(newSession).toHaveBeenCalledWith(target);
  });

  it("restores model preference and clears pending collaboration after idle release", async () => {
    const preference = {
      model: "gpt-deep",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "default",
    };
    const capturePreference = vi.fn(() => preference);
    const restorePreference = vi.fn();
    const modelClear = vi.fn();
    const collaborationClear = vi.fn();
    const newSession = vi.fn(async () => undefined);
    const service = createService({
      capturePreference,
      restorePreference,
      modelClear,
      collaborationClear,
      newSession,
    });

    await service.releaseIdle(target);

    expect(capturePreference).toHaveBeenCalledWith(target);
    expect(restorePreference).toHaveBeenCalledWith(target, preference);
    expect(collaborationClear).toHaveBeenCalledWith(target);
    expect(modelClear).not.toHaveBeenCalled();
  });

  it("does not release a busy Thread or one with a queue/pending interaction", async () => {
    const newSession = vi.fn();
    const activeService = createService({ activeTurn: { threadId: binding.threadId }, newSession });
    await expect(activeService.releaseIdle(target)).resolves.toEqual({
      status: "busy",
      threadId: binding.threadId,
    });
    expect(newSession).not.toHaveBeenCalled();

    const queueService = createService({ hasQueue: true, newSession });
    await expect(queueService.releaseIdle(target)).resolves.toEqual({
      status: "busy",
      threadId: binding.threadId,
    });
    expect(newSession).not.toHaveBeenCalled();

    const pendingService = createService({ pendingInteraction: true, newSession });
    await expect(pendingService.releaseIdle(target)).resolves.toEqual({
      status: "busy",
      threadId: binding.threadId,
    });
    expect(newSession).not.toHaveBeenCalled();

    const subagentService = createService({ pendingSubagent: true, newSession });
    await expect(subagentService.releaseIdle(target)).resolves.toEqual({
      status: "busy",
      threadId: binding.threadId,
    });
    expect(newSession).not.toHaveBeenCalled();
  });
});
