import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ModelOption } from "../application/index.js";

const deepseekSlugs = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const supportedSlug = "deepseek-v4-flash";

export function loadDeepseekModelOptions(
  environment: NodeJS.ProcessEnv = process.env,
): ModelOption[] {
  const codexHome = resolve(environment.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  const catalogPath = join(codexHome, "deepseek.models.json");
  if (!existsSync(catalogPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch {
    throw new Error(`DeepSeek 模型目录无效，请重新运行 codexc setup：${catalogPath}`);
  }
  const models = record(parsed).models;
  if (!Array.isArray(models)) {
    throw new Error(`DeepSeek 模型目录缺少 models：${catalogPath}`);
  }
  return models.flatMap((candidate) => {
    const model = record(candidate);
    if (typeof model.slug !== "string" || !deepseekSlugs.has(model.slug)) return [];
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
      throw new Error(`DeepSeek 模型目录缺少推理强度：${catalogPath}`);
    }
    return [{
      provider: "deepseek",
      available: model.slug === supportedSlug,
      ...(model.slug === supportedSlug
        ? {}
        : { unavailableReason: "DeepSeek 官方暂未支持该模型接入 Codex" }),
      id: model.slug,
      model: model.slug,
      displayName: `DeepSeek · ${typeof model.display_name === "string"
        ? model.display_name
        : model.slug}`,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: typeof model.default_reasoning_level === "string"
        ? model.default_reasoning_level
        : "high",
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
