import { describe, expect, it, vi } from "vitest";

import {
  ModelSelectionService,
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
  effort: string | null;
  serviceTier: string | null;
}, availableModels: ModelOption[] = models): ModelSelectionService {
  const codex = {
    listModels: async () => availableModels,
    writeDefaultFastMode: async () => undefined,
    readDefaultServiceTier: async () => "default",
  } satisfies ModelSelectionPort;
  let currentSettings = settings;
  const router = {
    current: () => currentSettings
      ? { target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }
      : undefined,
    modelSettings: () => currentSettings,
    updateModelSettings: (_threadId: string, next: typeof settings) => {
      currentSettings = next;
    },
  } as unknown as SessionRouter;
  return new ModelSelectionService(codex, router);
}

describe("ModelSelectionService", () => {
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

  it("starts a new Thread when selecting a model from another provider", async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const fork = vi.fn().mockResolvedValue(undefined);
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      current: () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
      fork,
      newSession,
      modelSettings: () => ({
        model: "gpt-main",
        modelProvider: "openai",
        effort: "low",
        serviceTier: "default",
      }),
    } as unknown as SessionRouter;
    const deepseek = {
      ...model("deepseek-v4-flash", ["low", "high"], "high"),
      provider: "deepseek",
    };
    const service = new ModelSelectionService(codex, router, undefined, [deepseek]);

    const state = await service.selectModel(target, "deepseek-v4-flash");

    expect(newSession).toHaveBeenCalledOnce();
    expect(fork).not.toHaveBeenCalled();
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

  it("starts a new Thread for another provider when no Thread is bound", async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const fork = vi.fn().mockResolvedValue(undefined);
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
      readDefaultServiceTier: async () => "default",
    } satisfies ModelSelectionPort;
    const router = {
      current: () => undefined,
      fork,
      newSession,
      modelSettings: () => undefined,
    } as unknown as SessionRouter;
    const deepseek = {
      ...model("deepseek-v4-flash", ["low", "high"], "high"),
      provider: "deepseek",
    };
    const service = new ModelSelectionService(codex, router, undefined, [deepseek]);

    await service.selectModel(target, "deepseek-v4-flash");

    expect(newSession).toHaveBeenCalledOnce();
    expect(fork).not.toHaveBeenCalled();
  });

  it("starts a clean OpenAI Thread when switching back from a third-party provider", async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const fork = vi.fn().mockResolvedValue(undefined);
    const readDefaultServiceTier = vi.fn().mockResolvedValue("fast");
    const codex = {
      listModels: async () => models,
      writeDefaultFastMode: async () => undefined,
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
    const pro = {
      ...model("deepseek-v4-pro", ["high"], "high"),
      provider: "deepseek",
      available: false,
      unavailableReason: "DeepSeek 官方暂未支持该模型接入 Codex",
    };
    const service = new ModelSelectionService(codex, router, undefined, [pro]);

    await expect(service.state(target)).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ model: "deepseek-v4-pro", available: false }),
      ]),
    });
    await expect(service.selectModel(target, "deepseek-v4-pro"))
      .rejects.toThrow("DeepSeek 官方暂未支持该模型接入 Codex");
    expect(newSession).not.toHaveBeenCalled();
  });
});
