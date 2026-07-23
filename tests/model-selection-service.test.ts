import { describe, expect, it } from "vitest";

import { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { CodexAppServerClient } from "../src/codex-client/client.js";
import type { Model } from "../src/codex-protocol/index.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };

function model(
  name: string,
  efforts: string[],
  defaultEffort: string,
  isDefault = false,
  supportsFast = false,
  fastTierId = "priority",
): Model {
  return {
    id: name,
    model: name,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: name,
    description: name,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: defaultEffort,
    inputModalities: ["text"],
    supportsPersonality: true,
    additionalSpeedTiers: supportsFast ? ["fast"] : [],
    serviceTiers: supportsFast
      ? [{ id: fastTierId, name: "Fast", description: "1.5x speed" }]
      : [],
    defaultServiceTier: "default",
    isDefault,
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
}): ModelSelectionService {
  const codex = { listModels: async () => models } as unknown as CodexAppServerClient;
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
      .rejects.toThrow("当前模型不支持该思考强度");
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
    const codex = { listModels: async () => tierModels } as unknown as CodexAppServerClient;
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
});
