import { parseTimestamp } from "./inbound.js";

export interface QqInboundButtonInteraction {
  readonly id: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly content: string;
  readonly buttonId: string;
  readonly sentAtMs: number;
}

export type QqButtonEventResult =
  | { readonly kind: "supported"; readonly interaction: QqInboundButtonInteraction }
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly reason: string };

/** Protocol-only parsing; authorization, command selection and deduplication belong to admission. */
export function parseQqButtonEvent(value: unknown, appId: string): QqButtonEventResult {
  const reject = (reason: string): QqButtonEventResult => ({ kind: "rejected", reason });
  if (!record(value) || value.op !== 0 || typeof value.t !== "string"
    || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(value.t)) return reject("invalid-envelope");
  if (value.t !== "INTERACTION_CREATE") return { kind: "ignored" };
  const interaction = value.d;
  if (!record(interaction)) return reject("invalid-interaction");
  if (!Number.isInteger(interaction.type)) return reject("invalid-type");
  if (interaction.type !== 11) return { kind: "ignored" };
  if (interaction.scene !== "c2c" || interaction.chat_type !== 2) return reject("unsupported-scene");
  if (!/^[0-9]+$/u.test(appId) || interaction.application_id !== appId) return reject("wrong-application");
  if (interaction.version !== 1) return reject("unsupported-version");
  if (!identifier(interaction.id) || interaction.id.startsWith("INTERACTION_CREATE:")) return reject("invalid-id");
  const actorId = interaction.user_openid;
  if (!identifier(actorId)) return reject("invalid-actor-id");
  // Empty optional fields are harmless; a second scene identity contradicts c2c attribution.
  if (["guild_id", "channel_id", "group_openid", "group_member_openid"]
    .some(key => key in interaction && interaction[key] !== "")) return reject("conflicting-scene");
  if (!record(interaction.data) || interaction.data.type !== 11 || !record(interaction.data.resolved)) {
    return reject("invalid-button-data");
  }
  const resolved = interaction.data.resolved;
  if (["user_id", "feature_id", "feedback_opt", "checked", "action", "message_scene", "authorize_data"]
    .some(key => key in resolved && resolved[key] !== "")) return reject("conflicting-button-data");
  if (typeof resolved.button_id !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(resolved.button_id)) {
    return reject("invalid-button-id");
  }
  if (typeof resolved.button_data !== "string" || !resolved.button_data.trim()
    || [...resolved.button_data].length > 100 || /[\p{Cc}\uD800-\uDFFF]/u.test(resolved.button_data)) {
    return reject("invalid-button-content");
  }
  const timestamp = parseTimestamp(interaction.timestamp);
  if (typeof timestamp !== "number") return reject(`timestamp-${timestamp.reason}`);
  return { kind: "supported", interaction: {
    id: interaction.id,
    actorId,
    conversationId: `c2c:${actorId}`,
    content: resolved.button_data,
    buttonId: resolved.button_id,
    sentAtMs: timestamp,
  } };
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && Buffer.byteLength(value, "utf8") <= 512 && !/[\s\p{Cc}\uD800-\uDFFF]/u.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
