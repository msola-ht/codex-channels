import { z } from "zod";

const identity = z.string().min(1).max(1024).refine(value => !/[\s\p{Cc}\uD800-\uDFFF]/u.test(value));
export const messageDisplayFields = [["operation_updates", "operationUpdates"], ["subagents", "subagentsEnabled"], ["streaming", "streamingEnabled"], ["commentary", "commentaryEnabled"], ["routine_notifications", "routineNotificationsEnabled"], ["plan_updates", "planUpdatesEnabled"], ["reasoning", "reasoningEnabled"], ["completion", "completion"], ["presentation_detail", "presentationDetail"]];
export const messageDisplayPresets = Object.freeze({
  concise: Object.freeze({ operation_updates: "hidden", subagents: false, streaming: true, commentary: false, routine_notifications: false, plan_updates: false, reasoning: false, completion: "brief", presentation_detail: "basic" }),
  standard: Object.freeze({ operation_updates: "compact", subagents: true, streaming: true, commentary: true, routine_notifications: true, plan_updates: true, reasoning: false, completion: "detailed", presentation_detail: "basic" }),
  detailed: Object.freeze({ operation_updates: "detailed", subagents: true, streaming: true, commentary: true, routine_notifications: true, plan_updates: true, reasoning: false, completion: "detailed", presentation_detail: "detailed" }),
  full: Object.freeze({ operation_updates: "full", subagents: true, streaming: true, commentary: true, routine_notifications: true, plan_updates: true, reasoning: true, completion: "detailed", presentation_detail: "full" }),
});

export function supportedMessageDisplayFields(selector) {
  return messageDisplayFields.map(([field]) => field).filter(field => selector?.surface === "weixin"
    ? ["completion", "presentation_detail", "routine_notifications"].includes(field)
    : !(selector?.surface === "qq" && selector.chat_kind === "group" && field === "streaming"));
}

export function identifyMessageDisplayPreset(settings, supportedFields = supportedMessageDisplayFields()) {
  return Object.entries(messageDisplayPresets).find(([, preset]) => messageDisplayFields.every(([stored, effective]) => !supportedFields.includes(stored) || settings[effective] === preset[stored]))?.[0] ?? "custom";
}
export const messageDisplayOverrideSchema = z.strictObject({
  surface: z.enum(["telegram", "feishu", "weixin", "qq"]),
  account_id: identity.optional(),
  chat_kind: z.enum(["direct", "group"]).optional(),
  chat_id: identity.optional(),
  operation_updates: z.enum(["full", "detailed", "compact", "failures", "hidden"]).optional(),
  subagents: z.boolean().optional(),
  streaming: z.boolean().optional(),
  commentary: z.boolean().optional(),
  routine_notifications: z.boolean().optional(),
  plan_updates: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  completion: z.enum(["off", "brief", "detailed"]).optional(),
  presentation_detail: z.enum(["basic", "detailed", "full"]).optional(),
}).superRefine((value, context) => {
  if (messageDisplayFields.some(([field]) => value[field] !== undefined && !supportedMessageDisplayFields(value).includes(field))
    || (value.chat_kind === "group" && value.surface !== "qq"))
    context.addIssue({ code: "custom", path: ["surface"], message: "该渠道不支持此类显示目标或字段" });
  if (value.chat_kind !== undefined && value.account_id === undefined)
    context.addIssue({ code: "custom", path: ["account_id"], message: "chat_kind 必须指定 account_id" });
  if (value.chat_id !== undefined && (value.account_id === undefined || value.chat_kind === undefined))
    context.addIssue({ code: "custom", path: ["chat_id"], message: "chat_id 必须指定 account_id 和 chat_kind" });
  if (!["operation_updates", "subagents", "streaming", "commentary", "routine_notifications", "plan_updates", "reasoning", "completion", "presentation_detail"].some(field => value[field] !== undefined))
    context.addIssue({ code: "custom", message: "显示覆盖必须至少包含一个字段" });
});

export function messageDisplaySelectorKey(value) {
  return JSON.stringify([value.surface, value.account_id ?? null, value.chat_kind ?? null, value.chat_id ?? null]);
}

export const messageDisplayOverridesSchema = z.array(messageDisplayOverrideSchema).max(512).superRefine((values, context) => {
  const seen = new Set();
  values.forEach((value, index) => {
    const key = messageDisplaySelectorKey(value);
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "显示覆盖目标不能重复" });
    seen.add(key);
  });
});

const fields = messageDisplayFields;

/** Resolve only validated configuration. Missing fields inherit; false and hidden are explicit. */
export function inspectMessageDisplaySettings(configuration, target) {
  return inspectMessageDisplayScope(configuration, { surface: target.surface, account_id: target.accountId, chat_kind: target.chatKind, chat_id: target.chatId });
}

export function inspectMessageDisplayScope(configuration, selector) {
  const settings = {};
  const sources = {};
  for (const [stored, field] of fields) { settings[field] = stored === "completion" ? configuration[stored] ?? "detailed" : stored === "presentation_detail" ? configuration[stored] ?? "basic" : stored === "subagents" || stored === "streaming" || stored === "commentary" || stored === "routine_notifications" ? configuration[stored] ?? true : configuration[stored]; sources[field] = "global"; }
  const matches = (configuration.overrides ?? []).filter(value => selector !== undefined && value.surface === selector.surface
    && (value.account_id === undefined || value.account_id === selector.account_id)
    && (value.chat_kind === undefined || value.chat_kind === selector.chat_kind)
    && (value.chat_id === undefined || value.chat_id === selector.chat_id))
    .sort((left, right) => specificity(left) - specificity(right));
  for (const value of matches) {
    const source = value.chat_id !== undefined ? "chat" : value.chat_kind !== undefined ? "chat-kind" : value.account_id !== undefined ? "account" : "surface";
    for (const [stored, field] of fields) if (value[stored] !== undefined) { settings[field] = value[stored]; sources[field] = source; }
  }
  return { settings, sources };
}

function specificity(value) { return value.chat_id !== undefined ? 4 : value.chat_kind !== undefined ? 3 : value.account_id !== undefined ? 2 : 1; }

export function resolveMessageDisplaySettings(configuration, target) {
  return inspectMessageDisplaySettings(configuration, target).settings;
}
