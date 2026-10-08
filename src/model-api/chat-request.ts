import type { RelayModelCapability, RelayReasoningEffort } from "../../runtime/chat-reasoning.mjs";
export type { RelayModelCapability, RelayReasoningEffort } from "../../runtime/chat-reasoning.mjs";
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
export function applyChatReasoningPolicy(request: DirectChatRequest, provider: string, mode: "passthrough" | "off", extraModel?: RelayModelCapability): DirectChatRequest {
  if (extraModel !== undefined && (!provider.startsWith("clp-") || extraModel.id !== request.model)) {
    throw new DirectChatRequestError("model", "Invalid model capability");
  }
  if (mode === "passthrough") return request;
  const knownOff = supportsChatReasoningOff(provider, request.model);
  if (!knownOff && !extraModel?.reasoning_efforts.includes("none")) return request;
  assertNoNestedReasoningControls(request, DirectChatRequestError);
  const result: DirectChatRequest = { ...request };
  for (const field of reasoningControlFields) delete result[field];
  if (provider.startsWith("ds-")) result.reasoning_effort = "none";
  else Object.assign(result, clinePassChatReasoningControl(request.model, "none"));
  return result;
}

/** Shared CLP wire mapping; exact Flash retains its verified DeepSeek control. */
export type ChatReasoningEffort = RelayReasoningEffort | "enabled";
export function clinePassChatReasoningControl(model: string, effort: ChatReasoningEffort):
  { reasoning: { effort: RelayReasoningEffort } | { enabled: boolean } } | { reasoning_effort: RelayReasoningEffort } {
  if (effort === "enabled") return { reasoning: { enabled: true } };
  if (model === "cline-pass/deepseek-v4.1-flash") return { reasoning: { effort } };
  return effort === "none" ? { reasoning: { enabled: false } } : { reasoning_effort: effort };
}
