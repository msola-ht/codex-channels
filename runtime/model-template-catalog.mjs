import { completeModelMessages } from "./model-template-prompts.mjs";
import { withThirdPartyLocalTools } from "./third-party-model-catalog.mjs";
import { readModelBaseSnapshot, sourceModelIdentity } from "./model-base-snapshot.mjs";

const autoReviewReplyLanguage = "请使用中文回复用户，包括自动审批结果、拒绝原因和后续操作说明；保留命令、路径及技术标识符原文。";

function localizeAutoReviewMessages(messages) {
  for (const [group, field] of [["approvals", "on_request_auto_review"], ["auto_review", "rejection_instructions"]]) {
    const prompt = messages?.[group]?.[field];
    if (typeof prompt === "string" && prompt.trim() && !prompt.includes(autoReviewReplyLanguage)) {
      messages[group][field] = `${prompt}\n\n${autoReviewReplyLanguage}`;
    }
  }
  return messages;
}

function neutralizeSourceIdentity(model) {
  if (typeof model.model_messages?.instructions_template === "string") {
    model.model_messages.instructions_template = model.model_messages.instructions_template.replace(sourceModelIdentity, "You are a coding assistant.");
  }
  if (typeof model.base_instructions === "string") {
    model.base_instructions = model.base_instructions.replace(sourceModelIdentity, "You are a coding assistant.");
  }
}

/** Keep the extracted source intact; custom models must not claim its model identity. */
export function readCustomBaseModelCatalog(environment = process.env) {
  const catalog = readModelBaseSnapshot(environment).catalog;
  const messages = catalog.models[0].model_messages;
  if (typeof messages?.instructions_template !== "string" || !sourceModelIdentity.test(messages.instructions_template)) {
    throw new Error("固定底座的身份声明已变化，请先审核并更新自定义模板投影");
  }
  neutralizeSourceIdentity(catalog.models[0]);
  localizeAutoReviewMessages(catalog.models[0].model_messages);
  return { ...catalog, ...withThirdPartyLocalTools(catalog, environment) };
}

/** Only new custom definitions receive a source association; never infer one for saved models. */
export function withCustomBaseTemplate(definition, environment = process.env) {
  const base = readCustomBaseModelCatalog(environment).models[0];
  return { ...definition,
    experimentalSupportedTools: [...new Set([...(definition.experimentalSupportedTools ?? []), ...base.experimental_supported_tools.filter(tool => ["send_user_message_async", "clock"].includes(tool))])],
    template: definition.template ?? { source: "official", model: base.slug },
    modelMessages: localizeAutoReviewMessages(completeModelMessages(definition.modelMessages ?? {}, base.model_messages)) };
}

/** Snapshot messages at explicit creation/update time; never inject them while reading user files. */
export function completeCatalogPrompts(source, environment = process.env) {
  if (!source || !Array.isArray(source.models)) throw new Error("模型目录缺少 models");
  const result = structuredClone(source);
  const baseMessages = readCustomBaseModelCatalog(environment).models[0].model_messages;
  for (const model of result.models) {
    model.model_messages = localizeAutoReviewMessages(completeModelMessages(model.model_messages ?? {}, baseMessages));
    neutralizeSourceIdentity(model);
  }
  return { ...result, ...withThirdPartyLocalTools(result, environment) };
}

export function completeDefinitionPrompts(definitions, environment = process.env) {
  const baseMessages = readCustomBaseModelCatalog(environment).models[0].model_messages;
  return definitions.map(definition => {
    const modelMessages = localizeAutoReviewMessages(completeModelMessages(definition.modelMessages ?? {}, baseMessages));
    return { ...definition, modelMessages,
      ...(definition.template === undefined ? {} : {template: {source: definition.template.source, model: definition.template.model}}) };
  });
}
