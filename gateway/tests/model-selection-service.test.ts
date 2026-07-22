import { describe, expect, it } from "vitest";

import { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { CodexAppServerClient } from "../src/codex-client/client.js";
import type { Model } from "../src/codex-protocol/index.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, conversationId: "100" };

function model(name: string, efforts: string[], defaultEffort: string, isDefault = false): Model {
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
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}

const models = [
  model("gpt-main", ["low", "medium", "high"], "medium", true),
  model("gpt-deep", ["high", "xhigh"], "high"),
];

function createService(settings?: { model: string; effort: string | null }): ModelSelectionService {
  const codex = { listModels: async () => models } as unknown as CodexAppServerClient;
  const router = { modelSettings: () => settings } as unknown as SessionRouter;
  return new ModelSelectionService(codex, router);
}

describe("ModelSelectionService", () => {
  it("uses the App Server thread settings as the current selection", async () => {
    const service = createService({ model: "gpt-main", effort: "high" });

    await expect(service.state(target)).resolves.toMatchObject({
      model: "gpt-main",
      effort: "high",
      pending: false,
    });
  });

  it("selects a model and falls back to an effort supported by that model", async () => {
    const service = createService({ model: "gpt-main", effort: "medium" });

    const selected = await service.selectModel(target, "gpt-deep");

    expect(selected).toMatchObject({ model: "gpt-deep", effort: "high", pending: true });
    expect(service.turnOverrides(target)).toEqual({ model: "gpt-deep", effort: "high" });
  });

  it("accepts effort indexes and clears pending overrides after a successful turn", async () => {
    const service = createService({ model: "gpt-main", effort: "low" });

    await service.selectEffort(target, "3");
    expect(service.turnOverrides(target)).toEqual({ effort: "high" });

    service.markApplied(target);
    expect(service.turnOverrides(target)).toEqual({});
  });

  it("rejects an effort unsupported by the selected model", async () => {
    const service = createService({ model: "gpt-deep", effort: "high" });

    await expect(service.selectEffort(target, "low"))
      .rejects.toThrow("当前模型不支持该思考强度");
  });
});
