import { describe, expect, it, vi } from "vitest";

import {
  LunaReserveService,
  lunaReserveModel,
  type AccountRateLimits,
  type ModelOption,
} from "../src/application/index.js";
import { ConversationLockCoordinator } from "../src/application/conversation-lock-coordinator.js";
import type { ConversationTarget, OutputEvent } from "../src/conversation-core/index.js";
import type { ThreadModelSettings } from "../src/session-routing/index.js";

const target: ConversationTarget = {
  surface: "feishu",
  accountId: "app-1",
  conversationId: "chat-1",
};
const threadId = "thread-1";
const turnId = "turn-1";

describe("LunaReserveService", () => {
  it("switches an eligible OpenAI thread to reserve and restores its previous model", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.port.accountRateLimits
      .mockResolvedValueOnce(blockedLimits())
      .mockResolvedValueOnce(recoveredLimits());
    try {
      harness.service.markUsageLimit(threadId, turnId);
      harness.service.recoverAfterTurn(threadId, turnId);
      await vi.waitFor(() => expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenCalledTimes(1));

      expect(harness.port.accountRateLimits).toHaveBeenNthCalledWith(1, { background: false });
      expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenNthCalledWith(1, threadId, {
        model: lunaReserveModel,
        effort: "low",
        serviceTier: null,
        collaborationMode: "plan",
      });
      expect(harness.settings.model).toBe(lunaReserveModel);
      expect(harness.output.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          threadId,
          message: expect.stringContaining("排队消息也可能已经自动开始，请重新发送失败消息"),
        }),
        true,
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenCalledTimes(2));

      expect(harness.port.accountRateLimits).toHaveBeenNthCalledWith(2, { background: true });
      expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenNthCalledWith(2, threadId, {
        model: "gpt-5.6-sol",
        effort: "high",
        serviceTier: "fast",
        collaborationMode: "plan",
      });
      expect(harness.settings.model).toBe("gpt-5.6-sol");
    } finally {
      await harness.service.close();
      vi.useRealTimers();
    }
  });

  it("does not switch without a matching backend Luna Reserve offer", async () => {
    const harness = createHarness();
    harness.port.accountRateLimits.mockResolvedValue(blockedLimits({
      lunaReserve: {
        blockedModelSlug: "gpt-other",
        title: "Continue with Luna",
        description: "Reserve capacity is available.",
      },
    }));

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => expect(harness.port.accountRateLimits).toHaveBeenCalledOnce());
    await Promise.resolve();
    await harness.service.close();

    expect(harness.port.updateLunaReserveThreadSettings).not.toHaveBeenCalled();
    expect(harness.output.publish).not.toHaveBeenCalled();
  });

  it("does not switch while a collaboration mode selection is pending", async () => {
    const harness = createHarness();
    harness.port.accountRateLimits.mockResolvedValue(blockedLimits());
    harness.collaborationModes.hasPending.mockReturnValue(true);

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => expect(harness.port.accountRateLimits).toHaveBeenCalledOnce());
    await Promise.resolve();
    await harness.service.close();

    expect(harness.port.updateLunaReserveThreadSettings).not.toHaveBeenCalled();
  });

  it("does not override a manual model change while waiting for recovery", async () => {
    const harness = createHarness();
    harness.port.accountRateLimits
      .mockResolvedValueOnce(blockedLimits())
      .mockResolvedValueOnce(recoveredLimits());

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => expect(harness.settings.model).toBe(lunaReserveModel));
    harness.settings = {
      ...harness.settings,
      model: "gpt-user-choice",
    };

    harness.service.markUsageLimit(threadId, "turn-2");
    harness.service.recoverAfterTurn(threadId, "turn-2");
    await vi.waitFor(() => expect(harness.port.accountRateLimits).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    await harness.service.close();

    expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenCalledTimes(1);
    expect(harness.settings.model).toBe("gpt-user-choice");
  });

  it.each([
    [
      "an unsupported backend upsell remains present",
      { unsupportedUpsellPresent: true },
    ],
    [
      "the authoritative ordinary limit remains blocked",
      { ordinaryUsageLimit: rateLimit({ rateLimitReachedType: "rate_limit_reached" }) },
    ],
  ] satisfies Array<[string, Partial<AccountRateLimits>]>)(
    "does not restore while %s",
    async (_description, recoveryOverrides) => {
      vi.useFakeTimers();
      const harness = createHarness();
      harness.port.accountRateLimits
        .mockResolvedValueOnce(blockedLimits())
        .mockResolvedValueOnce(recoveredLimits(recoveryOverrides));
      try {
        harness.service.markUsageLimit(threadId, turnId);
        harness.service.recoverAfterTurn(threadId, turnId);
        await vi.waitFor(() => expect(harness.settings.model).toBe(lunaReserveModel));

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(harness.port.accountRateLimits).toHaveBeenCalledTimes(2));

        expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenCalledTimes(1);
        expect(harness.settings.model).toBe(lunaReserveModel);
      } finally {
        await harness.service.close();
        vi.useRealTimers();
      }
    },
  );

  it("reports a failed settings write without retrying or changing local state", async () => {
    const harness = createHarness();
    const failure = new Error("settings rejected");
    harness.port.accountRateLimits.mockResolvedValue(blockedLimits());
    harness.port.updateLunaReserveThreadSettings.mockRejectedValue(failure);

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => expect(harness.onError).toHaveBeenCalledWith(failure, threadId));
    await harness.service.close();

    expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenCalledOnce();
    expect(harness.settings.model).toBe("gpt-5.6-sol");
    expect(harness.output.publish).not.toHaveBeenCalled();
  });

  it("ignores a completion from a different turn", async () => {
    const harness = createHarness();
    harness.port.accountRateLimits.mockResolvedValue(blockedLimits());

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, "turn-other");
    await harness.service.close();

    expect(harness.port.accountRateLimits).not.toHaveBeenCalled();
    expect(harness.port.updateLunaReserveThreadSettings).not.toHaveBeenCalled();
  });

  it("does not query OpenAI limits for a third-party thread", async () => {
    const harness = createHarness();
    harness.settings = { ...harness.settings, modelProvider: "deepseek" };

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await harness.service.close();

    expect(harness.port.accountRateLimits).not.toHaveBeenCalled();
  });

  it("stops recovery polling when the thread is cleared", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.port.accountRateLimits.mockResolvedValue(blockedLimits());
    try {
      harness.service.markUsageLimit(threadId, turnId);
      harness.service.recoverAfterTurn(threadId, turnId);
      await vi.waitFor(() => expect(harness.settings.model).toBe(lunaReserveModel));

      harness.service.clearThread(threadId);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(harness.port.accountRateLimits).toHaveBeenCalledOnce();
    } finally {
      await harness.service.close();
      vi.useRealTimers();
    }
  });

  it("does not write settings when the thread is cleared during model lookup", async () => {
    const harness = createHarness();
    let resolveModel: ((model: ModelOption | null) => void) | undefined;
    harness.port.accountRateLimits.mockResolvedValue(blockedLimits());
    harness.port.lunaReserveModel.mockReturnValue(new Promise((resolve) => {
      resolveModel = resolve;
    }));

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => expect(harness.port.lunaReserveModel).toHaveBeenCalledOnce());
    harness.service.clearThread(threadId);
    resolveModel?.(modelOption({ model: lunaReserveModel }));
    await harness.service.close();

    expect(harness.port.updateLunaReserveThreadSettings).not.toHaveBeenCalled();
  });

  it("retries a completed usage-limit trigger after an invalidated refresh settles", async () => {
    const harness = createHarness();
    let resolveFirstRead: ((limits: AccountRateLimits) => void) | undefined;
    harness.port.accountRateLimits
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFirstRead = resolve;
      }))
      .mockResolvedValueOnce(blockedLimits({ accountId: "account-2" }));

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => expect(harness.port.accountRateLimits).toHaveBeenCalledOnce());

    harness.service.clearAccountState();
    harness.service.markUsageLimit(threadId, "turn-2");
    harness.service.recoverAfterTurn(threadId, "turn-2");
    resolveFirstRead?.(blockedLimits());

    await vi.waitFor(() => {
      expect(harness.port.accountRateLimits).toHaveBeenCalledTimes(2);
      expect(harness.settings.model).toBe(lunaReserveModel);
    });
    await harness.service.close();
  });

  it("waits for an automatically started queued turn to complete before switching", async () => {
    const harness = createHarness();
    harness.port.accountRateLimits.mockResolvedValue(blockedLimits());
    harness.active = true;

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => expect(harness.port.accountRateLimits).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(harness.port.updateLunaReserveThreadSettings).not.toHaveBeenCalled();

    harness.active = false;
    harness.service.recoverAfterTurn(threadId, "queued-turn");
    await vi.waitFor(() => {
      expect(harness.port.accountRateLimits).toHaveBeenCalledTimes(2);
      expect(harness.settings.model).toBe(lunaReserveModel);
    });
    await harness.service.close();
  });

  it("warns without claiming a settings write that finishes after the account is invalidated", async () => {
    const harness = createHarness();
    let resolveWrite: (() => void) | undefined;
    harness.port.accountRateLimits.mockResolvedValue(blockedLimits());
    harness.port.updateLunaReserveThreadSettings.mockReturnValue(new Promise<undefined>((resolve) => {
      resolveWrite = () => resolve(undefined);
    }));

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => {
      expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenCalledOnce();
    });

    harness.service.clearAccountState();
    resolveWrite?.();
    await vi.waitFor(() => {
      expect(harness.output.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          threadId,
          message: expect.stringContaining("账户已发生变化，请确认当前 Session 模型"),
        }),
        true,
      );
    });
    await harness.service.close();

    expect(harness.settings.model).toBe("gpt-5.6-sol");
  });

  it("warns after a prior thread invalidation when the account changes during a settings write", async () => {
    const harness = createHarness();
    let resolveFirstRead: ((limits: AccountRateLimits) => void) | undefined;
    let resolveWrite: (() => void) | undefined;
    harness.port.accountRateLimits
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFirstRead = resolve;
      }))
      .mockResolvedValueOnce(blockedLimits());
    harness.port.updateLunaReserveThreadSettings.mockReturnValue(new Promise<undefined>((resolve) => {
      resolveWrite = () => resolve(undefined);
    }));

    harness.service.markUsageLimit(threadId, turnId);
    harness.service.recoverAfterTurn(threadId, turnId);
    await vi.waitFor(() => expect(harness.port.accountRateLimits).toHaveBeenCalledOnce());

    harness.service.clearThread(threadId);
    harness.service.markUsageLimit(threadId, "turn-2");
    harness.service.recoverAfterTurn(threadId, "turn-2");
    resolveFirstRead?.(blockedLimits());
    await vi.waitFor(() => {
      expect(harness.port.updateLunaReserveThreadSettings).toHaveBeenCalledOnce();
    });

    harness.service.clearAccountState();
    resolveWrite?.();
    await vi.waitFor(() => {
      expect(harness.output.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          threadId,
          message: expect.stringContaining("账户已发生变化，请确认当前 Session 模型"),
        }),
        true,
      );
    });
    await harness.service.close();
  });

  it("shares one account read across all Reserve threads in a recovery poll", async () => {
    vi.useFakeTimers();
    const harness = createMultiThreadHarness();
    harness.port.accountRateLimits
      .mockResolvedValueOnce(blockedLimits())
      .mockResolvedValueOnce(blockedLimits())
      .mockResolvedValue(recoveredLimits());
    try {
      for (const entry of harness.threads) {
        harness.service.markUsageLimit(entry.threadId, entry.turnId);
        harness.service.recoverAfterTurn(entry.threadId, entry.turnId);
      }
      await vi.waitFor(() => {
        expect(harness.threads.every((entry) =>
          entry.settings().model === lunaReserveModel)).toBe(true);
      });
      harness.port.accountRateLimits.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => {
        expect(harness.threads.every((entry) =>
          entry.settings().model === "gpt-5.6-sol")).toBe(true);
      });

      expect(harness.port.accountRateLimits).toHaveBeenCalledTimes(1);
      expect(harness.port.accountRateLimits).toHaveBeenCalledWith({ background: true });
    } finally {
      await harness.service.close();
      vi.useRealTimers();
    }
  });
});

function createHarness() {
  let active = false;
  let settings: ThreadModelSettings = {
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    effort: "high",
    serviceTier: "fast",
    collaborationMode: "plan",
  };
  const normalModel = modelOption({
    model: "gpt-5.6-sol",
    defaultReasoningEffort: "medium",
    serviceTiers: [{ id: "fast", name: "Fast" }],
    defaultServiceTier: null,
  });
  const reserveModel = modelOption({
    model: lunaReserveModel,
    displayName: "Luna Reserve",
    supportedReasoningEfforts: [{ effort: "low", description: "Low" }],
    defaultReasoningEffort: "low",
    serviceTiers: [],
    defaultServiceTier: null,
  });
  const port = {
    accountRateLimits: vi.fn<() => Promise<AccountRateLimits>>(),
    lunaReserveModel: vi.fn<() => Promise<ModelOption | null>>(async () => reserveModel),
    updateLunaReserveThreadSettings: vi.fn(async () => undefined),
  };
  const output = {
    publish: vi.fn<(event: OutputEvent, critical?: boolean) => void>(),
  };
  const onError = vi.fn();
  const collaborationModes = {
    hasPending: vi.fn(() => false),
  };
  const service = new LunaReserveService({
    port,
    router: {
      current: () => ({ target, workspaceId: "workspace", threadId, sessionId: threadId }),
      modelSettingsForThread: () => settings,
      targetForThread: (candidateThreadId) => candidateThreadId === threadId ? target : undefined,
      updateModelSettings: (_candidateThreadId, next) => { settings = next; },
    },
    models: {
      hasPending: () => false,
      state: async () => ({
        models: [normalModel],
        model: settings.model,
        modelProvider: "openai",
        effort: settings.effort,
        serviceTier: settings.serviceTier,
        pending: false,
        modelPending: false,
        effortPending: false,
        serviceTierPending: false,
      }),
    },
    collaborationModes,
    activity: {
      hasActiveTurn: () => active,
    },
    locks: new ConversationLockCoordinator(),
    output,
    onError,
  });
  return {
    service,
    port,
    output,
    onError,
    collaborationModes,
    get settings() { return settings; },
    set settings(next: ThreadModelSettings) { settings = next; },
    get active() { return active; },
    set active(next: boolean) { active = next; },
  };
}

function createMultiThreadHarness() {
  const threads = ["thread-1", "thread-2"].map((candidateThreadId, index) => {
    let settings: ThreadModelSettings = {
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "fast",
      collaborationMode: "default",
    };
    return {
      threadId: candidateThreadId,
      turnId: `turn-${index + 1}`,
      target: { ...target, conversationId: `chat-${index + 1}` },
      settings: () => settings,
      updateSettings: (next: ThreadModelSettings) => { settings = next; },
    };
  });
  const normalModel = modelOption({
    model: "gpt-5.6-sol",
    serviceTiers: [{ id: "fast", name: "Fast" }],
  });
  const reserveModel = modelOption({
    model: lunaReserveModel,
    supportedReasoningEfforts: [{ effort: "low", description: "Low" }],
    defaultReasoningEffort: "low",
  });
  const port = {
    accountRateLimits: vi.fn<() => Promise<AccountRateLimits>>(),
    lunaReserveModel: vi.fn(async () => reserveModel),
    updateLunaReserveThreadSettings: vi.fn(async () => undefined),
  };
  const service = new LunaReserveService({
    port,
    router: {
      current: (candidateTarget) => {
        const entry = threads.find((candidate) => candidate.target === candidateTarget);
        return entry
          ? {
              target: entry.target,
              workspaceId: "workspace",
              threadId: entry.threadId,
              sessionId: entry.threadId,
            }
          : undefined;
      },
      modelSettingsForThread: (candidateThreadId) =>
        threads.find((entry) => entry.threadId === candidateThreadId)?.settings(),
      targetForThread: (candidateThreadId) =>
        threads.find((entry) => entry.threadId === candidateThreadId)?.target,
      updateModelSettings: (candidateThreadId, next) => {
        threads.find((entry) => entry.threadId === candidateThreadId)?.updateSettings(next);
      },
    },
    models: {
      hasPending: () => false,
      state: async (candidateTarget) => {
        const entry = threads.find((candidate) => candidate.target === candidateTarget);
        const settings = entry?.settings();
        if (!settings) throw new Error("unknown test target");
        return {
          models: [normalModel],
          model: settings.model,
          modelProvider: "openai",
          effort: settings.effort,
          serviceTier: settings.serviceTier,
          pending: false,
          modelPending: false,
          effortPending: false,
          serviceTierPending: false,
        };
      },
    },
    activity: { hasActiveTurn: () => false },
    locks: new ConversationLockCoordinator(),
    output: { publish: vi.fn() },
  });
  return { service, port, threads };
}

function blockedLimits(overrides: Partial<AccountRateLimits> = {}): AccountRateLimits {
  const ordinaryUsageLimit = rateLimit({
    normalModelSlug: "gpt-5.6-sol",
    rateLimitReachedType: "rate_limit_reached",
  });
  return {
    limits: [ordinaryUsageLimit],
    ordinaryUsageLimit,
    resetCreditsAvailable: null,
    accountId: "account-1",
    ordinaryUsageAllowed: false,
    lunaReserve: {
      blockedModelSlug: "gpt-5.6-sol",
      title: "Continue with Luna",
      description: "Reserve capacity is available.",
    },
    unsupportedUpsellPresent: false,
    ...overrides,
  };
}

function recoveredLimits(overrides: Partial<AccountRateLimits> = {}): AccountRateLimits {
  const ordinaryUsageLimit = rateLimit();
  return {
    limits: [ordinaryUsageLimit],
    ordinaryUsageLimit,
    resetCreditsAvailable: null,
    accountId: "account-1",
    ordinaryUsageAllowed: true,
    lunaReserve: null,
    unsupportedUpsellPresent: false,
    ...overrides,
  };
}

function rateLimit(overrides: Partial<AccountRateLimits["limits"][number]> = {}) {
  return {
    limitId: "codex",
    limitName: "Codex",
    normalModelSlug: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: false,
    planType: "plus" as const,
    rateLimitReachedType: null,
    ...overrides,
  };
}

function modelOption(overrides: Partial<ModelOption>): ModelOption {
  const model = overrides.model ?? "gpt-test";
  return {
    id: model,
    model,
    displayName: model,
    supportedReasoningEfforts: [
      { effort: "medium", description: "Medium" },
      { effort: "high", description: "High" },
    ],
    defaultReasoningEffort: "medium",
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    inputModalities: ["text"],
    ...overrides,
  };
}
