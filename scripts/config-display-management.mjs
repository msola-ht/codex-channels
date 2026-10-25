import { inspectMessageDisplayScope, messageDisplayOverrideSchema, messageDisplaySelectorKey } from "../runtime/message-display-policy.mjs";
import { isTelegramEnabled, validateGatewayConfigStructureDocument } from "../runtime/gateway-config.mjs";
import { invalidSetting } from "./config-management-error.mjs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertStateDatabaseSchema } from "../dist/storage/index.js";

const fields = ["operation_updates", "subagents", "plan_updates", "reasoning", "completion"];
const selectorFields = ["surface", "account_id", "chat_kind", "chat_id"];
function supportedFields(selector) { return selector.surface === "weixin" ? ["completion"] : fields; }

function selectors(document, targets = []) {
  const result = [];
  const add = selector => result.push(selector);
  const accounts = [
    ["telegram", "default", isTelegramEnabled(document.telegram)],
    ["feishu", document.feishu?.app_id, document.feishu?.enabled === true],
    ["qq", document.qq?.app_id, document.qq?.enabled === true],
    ["weixin", document.weixin?.account_id, document.weixin?.enabled === true],
  ];
  for (const [surface, account_id, enabled] of accounts) {
    if (!enabled || !account_id) continue;
    add({ surface }); add({ surface, account_id }); add({ surface, account_id, chat_kind: "direct" });
    if (surface === "weixin") {
      for (const chat_id of document.weixin.allowed_user_ids ?? []) add({ surface, account_id, chat_kind: "direct", chat_id });
    }
    if (surface === "qq") {
      for (const chat_id of document.qq.allowed_user_openids ?? []) add({ surface, account_id, chat_kind: "direct", chat_id });
      if (document.qq.groups?.length) add({ surface, account_id, chat_kind: "group" });
      for (const group of document.qq.groups ?? []) add({ surface, account_id, chat_kind: "group", chat_id: group.group_openid });
    }
  }
  for (const selector of targets) add(selector);
  return result;
}

export function readDisplayTargets(document, configPath) {
  if (!document.feishu?.enabled) return { selectors: [], status: "not-needed" };
  const databasePath = resolve(dirname(configPath), document.storage?.database_path ?? "data/gateway.sqlite3");
  if (!existsSync(databasePath)) return { selectors: [], status: "missing" };
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    assertStateDatabaseSchema(database);
    const rows = database.prepare(`SELECT DISTINCT a.account_id AS accountId, a.conversation_id AS chatId, a.actor_id AS actorId
      FROM conversation_actors a
      WHERE a.surface = 'feishu' AND a.account_id = ? AND (
        EXISTS (SELECT 1 FROM conversation_bindings b WHERE b.surface = a.surface AND b.account_id = a.account_id AND b.conversation_id = a.conversation_id)
        OR EXISTS (SELECT 1 FROM conversation_background_bindings b WHERE b.surface = a.surface AND b.account_id = a.account_id AND b.conversation_id = a.conversation_id)
      ) LIMIT 2049`).all(document.feishu.app_id);
    if (rows.length > 2048) return { selectors: [], status: "unavailable" };
    const allowed = new Set(document.feishu.allowed_open_ids ?? []);
    const values = rows.filter(row => allowed.has(row.actorId)).map(row => ({ surface: "feishu", account_id: row.accountId, chat_kind: "direct", chat_id: row.chatId }));
    if (values.some(value => !messageDisplayOverrideSchema.safeParse({ ...value, reasoning: false }).success)) return { selectors: [], status: "unavailable" };
    return { selectors: [...new Map(values.map(value => [messageDisplaySelectorKey(value), value])).values()], status: "available" };
  } catch {
    return { selectors: [], status: "unavailable" };
  } finally { database?.close(); }
}

function selectorOf(value) { return Object.fromEntries(selectorFields.filter(field => value[field] !== undefined).map(field => [field, value[field]])); }

export function projectDisplayScopes(document, configuration, targets = []) {
  const available = selectors(document, targets);
  const writable = new Set(available.map(messageDisplaySelectorKey));
  const all = new Map(available.map(value => [messageDisplaySelectorKey(value), value]));
  for (const value of configuration.overrides ?? []) all.set(messageDisplaySelectorKey(value), selectorOf(value));
  return [...all].map(([id, selector]) => {
    const stored = (configuration.overrides ?? []).find(value => messageDisplaySelectorKey(value) === id);
    const override = Object.fromEntries(fields.filter(field => stored?.[field] !== undefined).map(field => [field, stored[field]]));
    const inspected = inspectMessageDisplayScope(configuration, selector);
    return { id, selector, writable: writable.has(id), supportedFields: supportedFields(selector), override, effective: inspected.settings, sources: inspected.sources };
  });
}

export function applyDisplayScopeSetting(document, input, configPath) {
  const value = input.value;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(field => !["selector", "field", "action", "value"].includes(field))) throw invalidSetting("value", "invalid-input", "显示覆盖输入无效");
  if (!fields.includes(value.field) || !["set", "inherit"].includes(value.action)) throw invalidSetting("value", "invalid-input", "请选择显示字段与明确的设置或继承操作");
  if (value.action === "inherit" && Object.hasOwn(value, "value")) throw invalidSetting("value", "invalid-input", "恢复继承不能包含值");
  const selector = value.selector;
  if (!selector || typeof selector !== "object" || Array.isArray(selector) || Object.keys(selector).some(field => !selectorFields.includes(field))) throw invalidSetting("selector", "invalid-input", "显示目标无效");
  const parsed = messageDisplayOverrideSchema.safeParse({ ...selector, [value.field]: value.action === "set" ? value.value : value.field === "operation_updates" ? "compact" : value.field === "completion" ? "detailed" : false });
  if (!parsed.success) throw invalidSetting("value", "invalid-input", "显示目标或字段值无效");
  const key = messageDisplaySelectorKey(selector);
  const display = document.display ?? {};
  const overrides = [...(display.overrides ?? [])];
  const index = overrides.findIndex(entry => messageDisplaySelectorKey(entry) === key);
  const targets = readDisplayTargets(document, configPath);
  if (value.action === "set" && !selectors(document, targets.selectors).some(entry => messageDisplaySelectorKey(entry) === key)) throw invalidSetting("selector", "invalid-input", "目标未启用、未授权、不可读或不支持显示；请重新读取范围");
  if (value.action === "inherit" && index < 0) return { value: projectDisplayScope(document, selector, targets.selectors), activation: "none", backupRequired: true };
  const next = { ...(index < 0 ? selector : overrides[index]) };
  if (value.action === "set") next[value.field] = value.value;
  else delete next[value.field];
  if (index >= 0) overrides.splice(index, 1);
  if (fields.some(field => next[field] !== undefined)) overrides.splice(index < 0 ? overrides.length : index, 0, next);
  document.display = { ...display };
  if (overrides.length) document.display.overrides = overrides;
  else delete document.display.overrides;
  return { value: projectDisplayScope(document, selector, targets.selectors), activation: "restart-gateway", backupRequired: true };
}

function projectDisplayScope(document, selector, targets = []) {
  const configuration = validateGatewayConfigStructureDocument(document).display;
  const state = projectDisplayScopes(document, configuration, targets).find(entry => entry.id === messageDisplaySelectorKey(selector));
  if (state) return state;
  const inspected = inspectMessageDisplayScope(configuration, selector);
  return { id: messageDisplaySelectorKey(selector), selector, writable: false, supportedFields: supportedFields(selector), override: {}, effective: inspected.settings, sources: inspected.sources };
}
