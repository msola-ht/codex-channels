import { supportsChatReasoningOff } from "../../runtime/chat-reasoning.mjs";
import { ModelConversionError } from "./validation.js";
import { assertNoNestedReasoningControls, isRequestObject, reasoningControlFields, validateDirectModel, validateDirectStream } from "./direct-request.js";

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
  if (!isRequestObject(value)) throw new DirectChatRequestError("body", "Expected a JSON object");
  const model = validateDirectModel(value.model, DirectChatRequestError);
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new DirectChatRequestError("messages", "Expected a nonempty message array");
  }
  for (const [index, message] of value.messages.entries()) {
    if (!isRequestObject(message)) throw new DirectChatRequestError(`messages[${index}]`, "Expected a message object");
  }
  const stream = validateDirectStream(value.stream, DirectChatRequestError);
  // The response observer and metrics contract currently support exactly one choice.
  if (value.n !== undefined && value.n !== null && value.n !== 1) {
    throw new DirectChatRequestError("n", "Relay supports only one choice (n=1)");
  }
  // Keep the documented JSON default independent of the upstream's SSE default.
  // No other field is deleted, coerced, resolved or used to select credentials/network routes.
  const copied = structuredClone(value);
  return { ...copied, model, messages: copied.messages as Record<string, unknown>[], stream };
}

/** Explicit per-key policy, after authentication; passthrough keeps all client parameters. */
export function applyChatReasoningPolicy(request: DirectChatRequest, provider: string, mode: "passthrough" | "off"): DirectChatRequest {
  if (mode === "passthrough") return request;
  if (!supportsChatReasoningOff(provider, request.model)) throw new DirectChatRequestError("model", "Reasoning off is not supported for this provider and model");
  assertNoNestedReasoningControls(request, DirectChatRequestError);
  const result: DirectChatRequest = { ...request };
  for (const field of reasoningControlFields) delete result[field];
  if (provider.startsWith("ds-")) result.reasoning_effort = "none";
  else result.reasoning = { effort: "none" };
  return result;
}
