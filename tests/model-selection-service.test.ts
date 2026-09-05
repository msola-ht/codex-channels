import { describe, expect, it, vi } from "vitest";

import {
  listProviders,
  ModelSelectionService,
  resolveProvider,
  type ModelOption,
  type ModelSelectionPort,
} from "../src/application/index.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };

function model(
  name: string,
  efforts: string[],
  defaultEffort: string,
  isDefault = false,
  supportsFast = false,
  fastTierId = "priority",
  inputModalities: ModelOption["inputModalities"] = ["text", "image"],
): ModelOption {
  return {
    id: name,
    model: name,
    displayName: name,
    supportedReasoningEfforts: efforts.map((effort) => ({
      effort,
      description: effort,
    })),
    defaultReasoningEffort: defaultEffort,
    serviceTiers: supportsFast
      ? [{ id: fastTierId, name: "Fast" }]
      : [],
    defaultServiceTier: "default",
    isDefault,
    inputModalities,
  };
}

const models = [
  model("gpt-main", ["low", "medium", "high"], "medium", true, true),
  model("gpt-deep", ["high", "xhigh"], "high"),
];

function createService(settings?: {
  model: string;
  modelProvider?: string;
  effort: string | null;
  serviceTier: string | null;
}, availableModels: ModelOption[] = models): ModelSelectionService {
  const codex = {
    listModels: async () => availableModels,
    writeDefaultFastMode: async () => undefined,
    readDefaultReasoningEffort: async () => null,
    readDefaultServiceTier: async () => "default",
  } satisfies ModelSelectionPort;
  let currentSettings = settings;
  const router = {
    newSession: async () => undefined,
    current: () => currentSettings
      ? { target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }
      : undefined,
    modelSettings: () => currentSettings,
    workspace: () => ({ id: "main", name: "main", cwd: "/workspace" }),
    updateModelSettings: (_threadId: string, next: typeof settings) => {
      currentSettings = next;
    },
  } as unknown as SessionRouter;
  return new ModelSelectionService(codex, router);
}

describe("ModelSelectionService", () => {
  it("uses the configured primary Provider as the default before any selection", async () => {
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      current: () => undefined,
      modelSettings: () => undefined,
      newSession: async () => undefined,
    } as unknown as SessionRouter;
    const service = new ModelSelectionService(codex, router, undefined, [], "OpenAI");

    const state = await service.state(target);

    expect(state.modelProvider).toBe("OpenAI");
    expect(state.model).toBe("gpt-main");
  });

  it("exposes the official catalog under a custom switching Provider alias", async () => {
    const newSession = vi.fn(async () => undefined);
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      current: () => ({
        target,
        workspaceId: "main",
        threadId: "thread-1",
        sessionId: "session-1",
      }),
      modelSettings: () => ({
        model: "gpt-main",
        modelProvider: "openai",
        effort: "medium",
        serviceTier: "default",
      }),
      newSession,
      workspace: () => ({ id: "main", name: "main", cwd: "/workspace" }),
    } as unknown as SessionRouter;
    const service = new ModelSelectionService(
      codex,
      router,
      undefined,
      [],
      "openai",
      [{ provider: "OpenAI", displayName: "OpenAI", defaultModel: "gpt-deep" }],
    );

    const state = await service.state(target);

    expect(state.models.map(({ model, provider, displayName, isDefault }) => ({
      model,
      provider: provider ?? "openai",
      displayName,
      isDefault,
    }))).toEqual([
      { model: "gpt-main", provider: "openai", displayName: "gpt-main", isDefault: true },
      { model: "gpt-deep", provider: "openai", displayName: "gpt-deep", isDefault: false },
      {
        model: "gpt-main",
        provider: "OpenAI",
        displayName: "OpenAI · gpt-main",
        isDefault: false,
      },
      {
        model: "gpt-deep",
        provider: "OpenAI",
        displayName: "OpenAI · gpt-deep",
        isDefault: true,
      },
    ]);

    await service.selectModel(target, "4");
    expect(newSession).toHaveBeenCalledOnce();
    expect(service.turnOverrides(target)).toMatchObject({
      model: "gpt-deep",
      modelProvider: "OpenAI",
      effort: "high",
    });
  });

  it("does not copy OpenAI retirement hints to custom Provider aliases", async () => {
    const official = {
      ...models[0]!,
      multiAgentVersion: "v2" as const,
      upgrade: { model: "gpt-next", retirementAtSeconds: 1_893_456_000 },
    };
    const service = new ModelSelectionService(
      {
        listModels: async () => [official],
        writeDefaultFastMode: async () => undefined,
        readDefaultReasoningEffort: async () => null,
        readDefaultServiceTier: async () => "default",
      },
      { modelSettings: () => undefined } as unknown as SessionRouter,
      undefined,
      [],
      "openai",
      [{ provider: "codeproxy-dev", displayName: "codeproxy-dev", defaultModel: official.model }],
    );

    const state = await service.state(target);
    expect(state.models[0]).toMatchObject({
      multiAgentVersion: "v2",
      upgrade: { model: "gpt-next" },
    });
    expect(state.models[0]?.provider).toBeUndefined();
    expect(state.models[1]).toMatchObject({
      provider: "codeproxy-dev",
      multiAgentVersion: "v2",
    });
    expect(state.models[1]).not.toHaveProperty("upgrade");
  });

  it("keeps identical model IDs from different Providers independently selectable", async () => {
    const sharedModel = "deepseek-v4-flash";
    const deepseek = { ...model(sharedModel, ["high"], "high"), provider: "deepseek" };
    const openCodeGo = {
      ...model(sharedModel, ["high"], "high"),
      provider: "opencode-go",
      displayName: "OpenCode Go · DeepSeek V4 Flash",
    };
    const service = createService({
      model: sharedModel,
      modelProvider: "deepseek",
      effort: "high",
      serviceTier: "default",
    }, [deepseek, openCodeGo]);

    const state = await service.state(target);
    expect(state.models).toHaveLength(2);
    expect(state.modelProvider).toBe("deepseek");
    await service.selectModel(target, "2");
    expect(service.turnOverrides(target)).toMatchObject({
      model: sharedModel,
      modelProvider: "opencode-go",
    });
  });

  it("resolves the configured default model within the primary Provider", async () => {
    const sharedModel = "deepseek-v4-flash";
    const openAi = model(sharedModel, ["medium"], "medium", true);
    const openCodeGo = {
      ...model(sharedModel, ["high"], "high"),
      provider: "opencode-go",
    };
    const codex = {
      listModels: async () => [openAi],
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = { modelSettings: () => undefined } as unknown as SessionRouter;
    const service = new ModelSelectionService(
      codex,
      router,
      sharedModel,
      [openCodeGo],
      "opencode-go",
    );

    const state = await service.state(target);
    expect(state).toMatchObject({
      model: sharedModel,
      modelProvider: "opencode-go",
      effort: "high",
    });
    expect(state.models).toHaveLength(1);
  });

  it("rejects a configured default model outside the primary Provider", async () => {
    const deepseek = {
      ...model("deepseek-v4-flash", ["high"], "high"),
      provider: "deepseek",
    };
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = { modelSettings: () => undefined } as unknown as SessionRouter;
    const service = new ModelSelectionService(
      codex,
      router,
      deepseek.model,
      [deepseek],
      "openai",
    );

    await expect(service.state(target)).rejects.toThrow(
      "配置的默认模型不属于当前主 Provider openai：deepseek-v4-flash",
    );
  });

  it("rejects an input modality not supported by the current model", async () => {
    const service = createService({
      model: "gpt-main",
      effort: "medium",
      serviceTier: "default",
    });

    await expect(service.requireInputModality(target, "audio"))
      .rejects.toThrow("当前模型 gpt-main 不支持语音输入，请发送文字或图片");
  });

  it("explains how to continue when the current model lacks image input", async () => {
    const service = createService({
      model: "deepseek-v4-flash",
      effort: "high",
      serviceTier: "default",
    }, [model(
        "deepseek-v4-flash",
        ["high"],
        "high",
        true,
        false,
        "priority",
        ["text"],
      )]);

    await expect(service.requireInputModality(target, "image"))
      .rejects.toThrow(
        "当前模型 deepseek-v4-flash 不支持图片输入，请发送文字或切换支持图片的模型",
      );
  });

  it("uses the App Server thread settings as the current selection", async () => {
    const service = createService({ model: "gpt-main", effort: "high", serviceTier: "priority" });

    await expect(service.state(target)).resolves.toMatchObject({
      model: "gpt-main",
      effort: "high",
      serviceTier: "priority",
      pending: false,
    });
  });

  it("selects a model and falls back to an effort supported by that model", async () => {
    const service = createService({ model: "gpt-main", effort: "medium", serviceTier: "default" });

    const selected = await service.selectModel(target, "gpt-deep");

    expect(selected).toMatchObject({ model: "gpt-deep", effort: "high", pending: true });
    expect(service.turnOverrides(target)).toEqual({ model: "gpt-deep", effort: "high" });
  });

  it("accepts effort indexes and clears pending overrides after a successful turn", async () => {
    const service = createService({ model: "gpt-main", effort: "low", serviceTier: "default" });

    await service.selectEffort(target, "3");
    expect(service.turnOverrides(target)).toEqual({ effort: "high" });

    service.markApplied(target);
    expect(service.turnOverrides(target)).toEqual({});
  });

  it("captures the current channel model and restores it after a compatible binding change", () => {
    let currentSettings = {
      model: "gpt-deep",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "default",
    };
    const router = {
      current: () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
      modelSettings: () => currentSettings,
    } as unknown as SessionRouter;
    const service = new ModelSelectionService({
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    }, router);

    const preference = service.capturePreference(target);
    currentSettings = {
      model: "gpt-main",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: "default",
    };
    service.restorePreference(target, preference);

    expect(service.turnOverrides(target)).toEqual({
      model: "gpt-deep",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "default",
    });
  });

  it("clears a resumed Fast tier when the retained channel preference is standard", () => {
    let currentSettings = {
      model: "gpt-main",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: null as string | null,
    };
    const router = {
      current: () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
      modelSettings: () => currentSettings,
    } as unknown as SessionRouter;
    const service = new ModelSelectionService({
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    }, router);

    const preference = service.capturePreference(target);
    currentSettings = {
      model: "gpt-main",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: "priority",
    };
    service.restorePreference(target, preference);

    expect(service.turnOverrides(target)).toEqual({
      model: "gpt-main",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: null,
    });
  });

  it("keeps an explicitly resumed Thread when its Provider differs from the channel preference", () => {
    let currentSettings = {
      model: "gpt-deep",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "default",
    };
    const router = {
      current: () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
      modelSettings: () => currentSettings,
    } as unknown as SessionRouter;
    const service = new ModelSelectionService({
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    }, router);

    const preference = service.capturePreference(target);
    currentSettings = {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      effort: "high",
      serviceTier: "default",
    };
    service.restorePreference(target, preference);

    expect(service.turnOverrides(target)).toEqual({});
  });

  it("falls back to the custom primary Provider when capturing and restoring preferences", () => {
    const currentSettings = {
      model: "gpt-main",
      effort: "medium",
      serviceTier: "default",
    } as {
      model: string;
      modelProvider?: string;
      effort: string | null;
      serviceTier: string | null;
    };
    const router = {
      current: () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
      modelSettings: () => currentSettings,
    } as unknown as SessionRouter;
    const service = new ModelSelectionService({
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    }, router, undefined, [], "OpenAI");

    const preference = service.capturePreference(target);

    expect(preference?.modelProvider).toBe("OpenAI");

    service.restorePreference(target, preference);

    expect(service.turnOverrides(target)).toMatchObject({
      modelProvider: "OpenAI",
    });
  });

  it("normalizes a stale built-in Provider id to the custom primary Provider", () => {
    let currentSettings = {
      model: "gpt-main",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: "default",
    };
    const router = {
      current: () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
      modelSettings: () => currentSettings,
      updateModelSettings: (_threadId: string, next: typeof currentSettings) => {
        currentSettings = next;
      },
    } as unknown as SessionRouter;
    const service = new ModelSelectionService({
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    }, router, undefined, [], "OpenAI");

    expect(service.status(target).modelProvider).toBe("OpenAI");
    expect(service.capturePreference(target)?.modelProvider).toBe("OpenAI");

    service.restorePreference(target, {
      model: "gpt-main",
      modelProvider: "openai",
      effort: null,
      serviceTier: "default",
    });

    expect(service.turnOverrides(target).modelProvider).toBe("OpenAI");
    expect(service.threadStartOptions(target).modelProvider).toBe("OpenAI");
  });

  it("rejects an effort unsupported by the selected model", async () => {
    const service = createService({ model: "gpt-deep", effort: "high", serviceTier: "default" });

    await expect(service.selectEffort(target, "low"))
      .rejects.toThrow("当前模型不支持该思考等级");
  });

  it("toggles Fast mode and sends the explicit Standard tier when turning it off", async () => {
    const service = createService({ model: "gpt-main", effort: "medium", serviceTier: "default" });

    await expect(service.selectFastMode(target, "")).resolves.toMatchObject({
      serviceTier: "priority",
      serviceTierPending: true,
    });
    expect(service.turnOverrides(target)).toEqual({ serviceTier: "priority" });

    await expect(service.selectFastMode(target, "off")).resolves.toMatchObject({
      serviceTier: "default",
      serviceTierPending: true,
    });
    expect(service.turnOverrides(target)).toEqual({ serviceTier: "default" });
  });

  it("persists an explicit Fast choice as the Codex CLI default", async () => {
    const writeDefaultFastMode = vi.fn().mockResolvedValue(undefined);
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      current: () => ({
        target,
        workspaceId: "main",
        threadId: "thread-1",
        sessionId: "session-1",
      }),
      modelSettings: () => ({
        model: "gpt-main",
        effort: "medium",
        serviceTier: "default",
      }),
    } as unknown as SessionRouter;
    const service = new ModelSelectionService(codex, router);

    await service.selectFastMode(target, "off");

    expect(writeDefaultFastMode).toHaveBeenCalledWith(false);
    expect(service.turnOverrides(target)).toEqual({});

    await service.selectFastMode(target, "on");

    expect(writeDefaultFastMode).toHaveBeenLastCalledWith(true);
    expect(service.turnOverrides(target)).toEqual({ serviceTier: "priority" });
  });

  it("updates the local thread settings after Fast overrides are accepted", async () => {
    const service = createService({ model: "gpt-main", effort: "medium", serviceTier: "default" });

    await service.selectFastMode(target, "on");
    service.markApplied(target);

    expect(service.status(target)).toMatchObject({
      serviceTier: "priority",
      pending: false,
      serviceTierPending: false,
    });

    await service.selectFastMode(target, "off");
    service.markApplied(target);

    expect(service.status(target)).toMatchObject({
      serviceTier: "default",
      pending: false,
      serviceTierPending: false,
    });
  });

  it("rejects Fast mode for a model that does not expose the Fast tier", async () => {
    const service = createService({ model: "gpt-deep", effort: "high", serviceTier: "default" });

    await expect(service.selectFastMode(target, "on"))
      .rejects.toThrow("当前模型不支持 Fast 模式");
  });

  it("does not change the OpenAI Fast default from a DeepSeek conversation", async () => {
    const writeDefaultFastMode = vi.fn().mockResolvedValue(undefined);
    const deepseek = {
      ...model("deepseek-v4-flash", ["high"], "high"),
      provider: "deepseek",
    };
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      modelSettings: () => ({
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
        effort: "high",
        serviceTier: "default",
      }),
    } as unknown as SessionRouter;
    const service = new ModelSelectionService(codex, router, undefined, [deepseek]);

    await expect(service.selectFastMode(target, "off"))
      .rejects.toThrow("当前模型不支持 Fast 模式");
    expect(writeDefaultFastMode).not.toHaveBeenCalled();
  });

  it("turns Fast mode off when switching to a model without that tier", async () => {
    const service = createService({ model: "gpt-main", effort: "medium", serviceTier: "priority" });

    await service.selectModel(target, "gpt-deep");

    expect(service.turnOverrides(target)).toEqual({
      model: "gpt-deep",
      effort: "high",
      serviceTier: "default",
    });
  });

  it("uses the selected model's catalog tier when switching with Fast enabled", async () => {
    const tierModels = [
      model("gpt-main", ["medium"], "medium", true, true),
      model("gpt-other", ["medium"], "medium", false, true, "fast"),
    ];
    const codex = {
      listModels: async () => tierModels,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      modelSettings: () => ({
        model: "gpt-main",
        effort: "medium",
        serviceTier: "priority",
      }),
    } as unknown as SessionRouter;
    const service = new ModelSelectionService(codex, router);

    await service.selectModel(target, "gpt-other");

    expect(service.turnOverrides(target)).toEqual({
      model: "gpt-other",
      effort: "medium",
      serviceTier: "fast",
    });
  });

  it("uses the target Provider configured effort when selecting a model from another provider", async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const fork = vi.fn().mockResolvedValue(undefined);
    const readDefaultReasoningEffort = vi.fn().mockResolvedValue("high");
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      current: () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
      fork,
      newSession,
      modelSettings: () => ({
        model: "gpt-main",
        modelProvider: "openai",
        effort: "medium",
        serviceTier: "default",
      }),
      workspace: () => ({ id: "main", name: "main", cwd: "/workspace" }),
    } as unknown as SessionRouter;
    const deepseek = {
      ...model("deepseek-v4-flash", ["low", "high"], "low"),
      provider: "deepseek",
    };
    const service = new ModelSelectionService(codex, router, undefined, [deepseek]);

    const state = await service.selectModel(target, "deepseek-v4-flash");

    expect(newSession).toHaveBeenCalledOnce();
    expect(fork).not.toHaveBeenCalled();
    expect(readDefaultReasoningEffort).toHaveBeenCalledWith("/workspace", "deepseek");
    expect(state).toMatchObject({
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      effort: "high",
      effortPending: true,
      providerPending: true,
    });
    expect(service.turnOverrides(target)).toMatchObject({ effort: "high" });
    expect(service.threadStartOptions(target)).toEqual({
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });
  });

  it("falls back to the model default when the target Provider configured effort is unsupported", async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const fork = vi.fn().mockResolvedValue(undefined);
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => "medium",
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      current: () => undefined,
      fork,
      newSession,
      modelSettings: () => undefined,
      workspace: () => ({ id: "main", name: "main", cwd: "/workspace" }),
    } as unknown as SessionRouter;
    const deepseek = {
      ...model("deepseek-v4-flash", ["low", "high"], "high"),
      provider: "deepseek",
    };
    const service = new ModelSelectionService(codex, router, undefined, [deepseek]);

    const state = await service.selectModel(target, "deepseek-v4-flash");

    expect(newSession).toHaveBeenCalledOnce();
    expect(fork).not.toHaveBeenCalled();
    expect(state.effort).toBe("high");
  });

  it("starts a clean OpenAI Thread when switching back from a third-party provider", async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const fork = vi.fn().mockResolvedValue(undefined);
    const readDefaultServiceTier = vi.fn().mockResolvedValue("fast");
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => "medium",
      readDefaultServiceTier,
    } as unknown as ModelSelectionPort;
    const router = {
      current: () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
      fork,
      newSession,
      workspace: () => ({ id: "main", name: "main", cwd: "/workspace" }),
      modelSettings: () => ({
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
        effort: "high",
        serviceTier: "default",
      }),
    } as unknown as SessionRouter;
    const service = new ModelSelectionService(codex, router);

    const state = await service.selectModel(target, "gpt-main");

    expect(newSession).toHaveBeenCalledOnce();
    expect(fork).not.toHaveBeenCalled();
    expect(readDefaultServiceTier).toHaveBeenCalledWith("/workspace", "openai");
    expect(state).toMatchObject({
      model: "gpt-main",
      serviceTier: "priority",
      serviceTierPending: true,
    });
  });

  it("shows but rejects an unavailable provider model", async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultReasoningEffort: async () => null,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      newSession,
      modelSettings: () => ({
        model: "gpt-main",
        modelProvider: "openai",
        effort: "medium",
        serviceTier: "default",
      }),
    } as unknown as SessionRouter;
    const preview = {
      ...model("deepseek-v5-preview", ["high"], "high"),
      provider: "deepseek",
      available: false,
      unavailableReason: "该模型尚未完成项目适配",
    };
    const service = new ModelSelectionService(codex, router, undefined, [preview]);

    await expect(service.state(target)).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ model: "deepseek-v5-preview", available: false }),
      ]),
    });
    await expect(service.selectModel(target, "deepseek-v5-preview"))
      .rejects.toThrow("该模型尚未完成项目适配");
    expect(newSession).not.toHaveBeenCalled();
  });

  it("filters models by the chosen provider and exposes providerFilter", async () => {
    const deep = { ...model("deepseek-v4-flash", ["high"], "high"), provider: "deepseek" };
    const service = createService(
      { model: "gpt-main", modelProvider: "openai", effort: "medium", serviceTier: "default" },
      [...models, deep],
    );

    expect(listProviders((await service.state(target)).models)).toEqual([
      "openai",
      "deepseek",
    ]);

    const browsed = await service.browseProvider(target, "deepseek");
    expect(browsed.providerFilter).toBe("deepseek");
    expect(browsed.models).toEqual([deep]);

    const after = await service.state(target);
    expect(after.providerFilter).toBe("deepseek");
    expect(after.models).toEqual([deep]);
    expect(resolveProvider(after.models, "1")).toBe("deepseek");
  });

  it("resolves numeric model selections within the active provider browse scope", async () => {
    const openAi = model("gpt-main", ["medium"], "medium", true);
    const deepseek = {
      ...model("deepseek-v4-flash", ["high"], "high"),
      provider: "deepseek",
    };
    const service = createService(
      { model: openAi.model, modelProvider: "openai", effort: "medium", serviceTier: "default" },
      [openAi, deepseek],
    );

    await service.browseProvider(target, "deepseek");
    await service.selectModel(target, "1");

    expect(service.turnOverrides(target)).toMatchObject({
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });
  });

  it("returns the selected provider scope after selecting a model", async () => {
    const deep = { ...model("deepseek-v4-flash", ["high"], "high"), provider: "deepseek" };
    const service = createService(
      { model: "gpt-main", modelProvider: "openai", effort: "medium", serviceTier: "default" },
      [...models, deep],
    );

    await service.browseProvider(target, "deepseek");
    const selected = await service.selectModel(target, "1");

    expect(selected.providerFilter).toBe("deepseek");
    expect(selected.models).toEqual([deep]);
  });
});
