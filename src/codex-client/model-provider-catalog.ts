import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelOption } from "../application/index.js";

interface ManagedCatalogDefinition {
  id: string;
  displayName: string;
  catalogFileName: string;
  defaultModel: string;
  defaultReasoningEffort: string;
  models: ReadonlyArray<{
    slug: string;
    available: boolean;
    unavailableReason?: string;
  }>;
}

export function loadManagedModelOptions(
  providerDirectory: string,
  enabled: boolean,
  definition: ManagedCatalogDefinition,
): ModelOption[] {
  if (!enabled) return [];
  const knownModels = new Map(definition.models.map((model) => [model.slug, model]));
  const catalogPath = join(providerDirectory, definition.catalogFileName);
  if (!existsSync(catalogPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${definition.displayName} 模型目录无效，请重新运行 codexc setup：${catalogPath}`,
      { cause: error },
    );
  }
  const models = record(parsed).models;
  if (!Array.isArray(models)) {
    throw new Error(`${definition.displayName} 模型目录缺少 models：${catalogPath}`);
  }
  return models.flatMap((candidate) => {
    const model = record(candidate);
    if (typeof model.slug !== "string") return [];
    const knownModel = knownModels.get(model.slug);
    if (!knownModel) return [];
    const levels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
      : [];
    const efforts = levels.flatMap((candidateLevel) => {
      const level = record(candidateLevel);
      return typeof level.effort === "string" && typeof level.description === "string"
        ? [{ effort: level.effort, description: level.description }]
        : [];
    });
    if (efforts.length === 0) {
      throw new Error(`${definition.displayName} 模型目录缺少思考等级：${catalogPath}`);
    }
    return [{
      provider: definition.id,
      available: knownModel.available,
      ...(knownModel.unavailableReason
        ? { unavailableReason: knownModel.unavailableReason }
        : {}),
      id: model.slug,
      model: model.slug,
      displayName: `${definition.displayName} · ${typeof model.display_name === "string"
        ? model.display_name
        : model.slug}`,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: typeof model.default_reasoning_level === "string"
        ? model.default_reasoning_level
        : definition.defaultReasoningEffort,
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: false,
      inputModalities: ["text" as const],
    }];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
