import { readFileSync } from "node:fs";
import { completeModelMessages } from "./model-template-prompts.mjs";

function readBaseModelCatalog() {
  const catalog = JSON.parse(readFileSync(new URL("./model-catalog-base.json", import.meta.url), "utf8"));
  if (!Array.isArray(catalog.models) || catalog.models.length !== 1
    || typeof catalog.models[0]?.slug !== "string" || !catalog.models[0].slug.trim()) throw new Error("基础模型模板缺失、无效或不唯一");
  return catalog;
}

/** Keep the extracted source intact; custom models must not claim its model identity. */
export function readCustomBaseModelCatalog() {
  const catalog = readBaseModelCatalog();
  const messages = catalog.models[0].model_messages;
  const identity = /^You are Codex, an agent based on [^\r\n]+?\.(?=\s|$)/u;
  if (typeof messages?.instructions_template !== "string" || !identity.test(messages.instructions_template)) {
    throw new Error("固定底座的身份声明已变化，请先审核并更新自定义模板投影");
  }
  messages.instructions_template = messages.instructions_template.replace(identity, "You are a coding assistant.");
  return catalog;
}

/** Only new custom definitions receive a source association; never infer one for saved models. */
export function withCustomBaseTemplate(definition) {
  const base = readCustomBaseModelCatalog().models[0];
  return { ...definition,
    template: definition.template ?? { source: "official", model: base.slug },
    modelMessages: completeModelMessages(definition.modelMessages ?? {}, base.model_messages) };
}

/** Snapshot messages at explicit creation/update time; never inject them while reading user files. */
export function completeCatalogPrompts(source) {
  if (!source || !Array.isArray(source.models)) throw new Error("模型目录缺少 models");
  const result = structuredClone(source);
  const baseMessages = readBaseModelCatalog().models[0].model_messages;
  for (const model of result.models) {
    model.model_messages = completeModelMessages(model.model_messages ?? {}, baseMessages);
  }
  return result;
}

export function completeDefinitionPrompts(definitions) {
  const baseMessages = readBaseModelCatalog().models[0].model_messages;
  return definitions.map(definition => {
    const modelMessages = completeModelMessages(definition.modelMessages ?? {}, baseMessages);
    return { ...definition, modelMessages,
      ...(definition.template === undefined ? {} : {template: {source: definition.template.source, model: definition.template.model}}) };
  });
}
