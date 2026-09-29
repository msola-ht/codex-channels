import { ModelConversionError } from "./validation.js";

/** Model parameters stay opaque to the relay; only local routing/delivery fields are typed. */
export interface DirectChatRequest extends Record<string, unknown> {
  model: string;
  messages: Record<string, unknown>[];
  stream: boolean;
}

export class DirectChatRequestError extends ModelConversionError {
  constructor(readonly param: string, readonly reason = "Invalid value or unsupported shape") {
    super(`${param}: ${reason}`);
  }
}

/** Preserve parsed JSON fields and values. Upstream owns model-specific validation. */
export function validateDirectChatRequest(value: unknown): DirectChatRequest {
  if (!record(value)) throw new DirectChatRequestError("body", "Expected a JSON object");
  const model = value.model;
  if (typeof model !== "string" || model.length === 0 || model.length > 200
    || [...model].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new DirectChatRequestError("model", "Expected a nonempty model identifier of at most 200 characters");
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 256) {
    throw new DirectChatRequestError("messages", "Expected 1 to 256 messages");
  }
  for (const [index, message] of value.messages.entries()) {
    if (!record(message)) throw new DirectChatRequestError(`messages[${index}]`, "Expected a message object");
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new DirectChatRequestError("stream", "Expected a boolean");
  }
  // The response observer and metrics contract currently support exactly one choice.
  if (value.n !== undefined && value.n !== null && value.n !== 1) {
    throw new DirectChatRequestError("n", "Relay supports only one choice (n=1)");
  }
  // Keep the documented JSON default independent of the upstream's SSE default.
  // No other field is deleted, coerced, resolved or used to select credentials/network routes.
  const copied = structuredClone(value);
  return { ...copied, model, messages: copied.messages as Record<string, unknown>[], stream: value.stream === true };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
