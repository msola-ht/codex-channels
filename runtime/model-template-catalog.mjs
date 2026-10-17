import { readFileSync } from "node:fs";
import { completeModelMessages } from "./model-template-prompts.mjs";

const catalog = JSON.parse(readFileSync(new URL("./model-catalog-base.json", import.meta.url), "utf8"));
const matches = catalog.models?.filter(model => model.slug === "gpt-6.1-sol");
if (matches?.length !== 1) throw new Error("基础模型模板缺失或不唯一");
const baseMessages = matches[0].model_messages;

/** Snapshot messages at explicit creation/update time; never inject them while reading user files. */
export function completeCatalogPrompts(source) {
  if (!source || !Array.isArray(source.models)) throw new Error("模型目录缺少 models");
  const result = structuredClone(source);
  for (const model of result.models) {
    model.model_messages = completeModelMessages(model.model_messages ?? {}, baseMessages);
  }
  return result;
}

export function completeDefinitionPrompts(definitions) {
  return definitions.map(definition => {
    const modelMessages = completeModelMessages(definition.modelMessages ?? {}, baseMessages);
    return { ...definition, modelMessages,
      ...(definition.template === undefined ? {} : {template: {source: definition.template.source, model: definition.template.model}}) };
  });
}
