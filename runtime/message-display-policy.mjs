import { z } from "zod";

const identity = z.string().min(1).max(1024).refine(value => !/[\s\p{Cc}\uD800-\uDFFF]/u.test(value));
export const messageDisplayOverrideSchema = z.strictObject({
  surface: z.enum(["telegram", "feishu", "weixin", "qq"]),
  account_id: identity.optional(),
  chat_kind: z.enum(["direct", "group"]).optional(),
  chat_id: identity.optional(),
  operation_updates: z.enum(["full", "compact", "failures", "hidden"]).optional(),
  subagents: z.boolean().optional(),
  plan_updates: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  completion: z.enum(["off", "brief", "detailed"]).optional(),
  presentation_detail: z.enum(["basic", "detailed"]).optional(),
}).superRefine((value, context) => {
  if ((value.surface === "weixin" && ["operation_updates", "subagents", "plan_updates", "reasoning"].some(field => value[field] !== undefined))
    || (value.chat_kind === "group" && value.surface !== "qq"))
    context.addIssue({ code: "custom", path: ["surface"], message: "该渠道不支持此类显示目标或字段" });
  if (value.chat_kind !== undefined && value.account_id === undefined)
    context.addIssue({ code: "custom", path: ["account_id"], message: "chat_kind 必须指定 account_id" });
  if (value.chat_id !== undefined && (value.account_id === undefined || value.chat_kind === undefined))
    context.addIssue({ code: "custom", path: ["chat_id"], message: "chat_id 必须指定 account_id 和 chat_kind" });
  if (!["operation_updates", "subagents", "plan_updates", "reasoning", "completion", "presentation_detail"].some(field => value[field] !== undefined))
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

const fields = [["operation_updates", "operationUpdates"], ["subagents", "subagentsEnabled"], ["plan_updates", "planUpdatesEnabled"], ["reasoning", "reasoningEnabled"], ["completion", "completion"], ["presentation_detail", "presentationDetail"]];

/** Resolve only validated configuration. Missing fields inherit; false and hidden are explicit. */
export function inspectMessageDisplaySettings(configuration, target) {
  return inspectMessageDisplayScope(configuration, { surface: target.surface, account_id: target.accountId, chat_kind: target.chatKind, chat_id: target.chatId });
}

export function inspectMessageDisplayScope(configuration, selector) {
  const settings = {};
  const sources = {};
  for (const [stored, field] of fields) { settings[field] = stored === "completion" ? configuration[stored] ?? "detailed" : stored === "presentation_detail" ? configuration[stored] ?? "basic" : stored === "subagents" ? configuration[stored] ?? true : configuration[stored]; sources[field] = "global"; }
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
