import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ModelInputModality,
  ModelOption,
} from "../application/index.js";

interface ManagedCatalogDefinition {
  id: string;
  displayName: string;
  catalogFileName: string;
  defaultReasoningEffort: string;
}

// 与 runtime/model-provider-runtime.mjs 的受管模型目录契约一致。
const modelSlugPattern = /^[a-z0-9][a-z0-9._-]{0,119}$/u;

export function loadManagedModelOptions(
  providerDirectory: string,
  enabled: boolean,
  definition: ManagedCatalogDefinition,
): ModelOption[] {
  if (!enabled) return [];
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
    if (typeof model.slug !== "string" || !modelSlugPattern.test(model.slug)) {
      throw new Error(`${definition.displayName} 模型目录包含无效模型名：${catalogPath}`);
    }
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
    const slug = model.slug;
    const inputModalities = parseInputModalities(
      model.input_modalities,
      definition.displayName,
      catalogPath,
    );
    return [{
      provider: definition.id,
      available: true,
      id: slug,
      model: slug,
      displayName: `${definition.displayName} · ${typeof model.display_name === "string"
        ? model.display_name
        : slug}`,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: typeof model.default_reasoning_level === "string"
        ? model.default_reasoning_level
        : definition.defaultReasoningEffort,
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: false,
      inputModalities,
    }];
  });
}

function parseInputModalities(
  value: unknown,
  displayName: string,
  catalogPath: string,
): ModelInputModality[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${displayName} 模型目录缺少输入能力：${catalogPath}`);
  }
  const allowed = new Set<ModelInputModality>(["text", "image", "audio"]);
  const modalities: ModelInputModality[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !allowed.has(candidate as ModelInputModality)) {
      throw new Error(`${displayName} 模型目录包含未知输入能力：${catalogPath}`);
    }
    const modality = candidate as ModelInputModality;
    if (modalities.includes(modality)) {
      throw new Error(`${displayName} 模型目录包含重复输入能力：${catalogPath}`);
    }
    modalities.push(modality);
  }
  if (!modalities.includes("text")) {
    throw new Error(`${displayName} 模型目录缺少文字输入能力：${catalogPath}`);
  }
  return modalities;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
