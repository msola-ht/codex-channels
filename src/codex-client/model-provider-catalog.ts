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
  defaultReasoningEffort?: string;
}

// Provider 注册与受控模型范围由 Bootstrap/Runtime 校验；目录允许单层命名空间。
const modelSlugPattern = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u;
// The member model ID is an opaque JSON field, not a URL path segment.
const aggregateModelSlugPattern = /^[a-zA-Z0-9_-]{1,64}\/[^\p{Cc}]{1,200}$/u;

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
  return parseModelOptions(parsed, definition, catalogPath, modelSlugPattern);
}

/** Map confirmed aggregate material without starting an App Server to read its catalog. */
export function parseAggregateModelOptions(catalog: unknown): ModelOption[] {
  return parseModelOptions(catalog, {
    id: "codexc-aggregate",
    displayName: "聚合提供商",
    catalogFileName: "aggregate-models.json",
  }, "聚合模型目录", aggregateModelSlugPattern, true);
}

function parseModelOptions(
  parsed: unknown,
  definition: ManagedCatalogDefinition,
  catalogPath: string,
  slugPattern: RegExp,
  aggregate = false,
): ModelOption[] {
  const models = record(parsed).models;
  if (!Array.isArray(models)) {
    throw new Error(`${definition.displayName} 模型目录缺少 models：${catalogPath}`);
  }
  return models.flatMap((candidate) => {
    const model = record(candidate);
    // Aggregate authentication is API-key based. Match upstream model/list's
    // API availability and picker visibility, including while the instance sleeps.
    if (aggregate && (model.visibility !== "list" || model.supported_in_api !== true)) return [];
    if (typeof model.slug !== "string" || !slugPattern.test(model.slug)
      || aggregate && model.slug.slice(model.slug.indexOf("/") + 1).trim() !== model.slug.slice(model.slug.indexOf("/") + 1)) {
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
    if (aggregate && (!Array.isArray(model.supported_reasoning_levels) || efforts.length !== levels.length)) {
      throw new Error(`${definition.displayName} 模型目录包含无效思考等级：${catalogPath}`);
    }
    if (efforts.length === 0 && !aggregate) {
      throw new Error(`${definition.displayName} 模型目录缺少思考等级：${catalogPath}`);
    }
    const slug = model.slug;
    const defaultReasoningEffort = typeof model.default_reasoning_level === "string"
      ? model.default_reasoning_level
      // Locked upstream ModelInfo -> ModelPreset maps an absent effort to None.
      : aggregate && model.default_reasoning_level == null ? "none" : definition.defaultReasoningEffort;
    if (typeof defaultReasoningEffort !== "string") {
      throw new Error(`${definition.displayName} 模型目录缺少默认思考等级：${catalogPath}`);
    }
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
      defaultReasoningEffort,
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
