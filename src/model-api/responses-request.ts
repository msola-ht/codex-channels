import { supportsChatReasoningOff } from "../../runtime/chat-reasoning.mjs";
import { ModelConversionError } from "./validation.js";

/** Native Responses payload; model-specific parameters remain upstream-owned. */
export interface DirectResponsesRequest extends Record<string, unknown> {
  model: string;
  input?: string | Record<string, unknown>[] | null;
  stream: boolean;
  store: false;
  background?: false;
}

export class DirectResponsesRequestError extends ModelConversionError {
  constructor(readonly param: string, readonly reason: string) {
    super(`${param}: ${reason}`);
  }
}

/** Stateless HTTP creation only. No Chat conversion or tool execution. */
export function validateDirectResponsesRequest(provider: string, value: unknown): DirectResponsesRequest {
  if (!record(value)) throw new DirectResponsesRequestError("body", "Expected a JSON object");
  const model = value.model;
  if (typeof model !== "string" || model.length === 0 || model.length > 200
    || [...model].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new DirectResponsesRequestError("model", "Expected a nonempty model identifier of at most 200 characters");
  }
  if (value.input == null) {
    if (typeof value.instructions !== "string" || !value.instructions.length) throw new DirectResponsesRequestError("input", "Expected input or instructions");
  } else if (typeof value.input !== "string") {
    if (!Array.isArray(value.input)) {
      throw new DirectResponsesRequestError("input", "Expected text or an input item array");
    }
    for (const [index, item] of value.input.entries()) {
      if (!record(item)) throw new DirectResponsesRequestError(`input[${index}]`, "Expected an input item object");
    }
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new DirectResponsesRequestError("stream", "Expected a boolean");
  }
  if (value.store !== undefined && typeof value.store !== "boolean") {
    throw new DirectResponsesRequestError("store", "Expected a boolean");
  }
  if (value.background !== undefined && typeof value.background !== "boolean") {
    throw new DirectResponsesRequestError("background", "Expected a boolean");
  }
  // DeepSeek ignores history references. Other upstreams may read shared-account history,
  // whose ownership Relay cannot attribute to the authenticated caller.
  if (!provider.startsWith("ds-")) {
    for (const field of ["previous_response_id", "conversation"]) {
      if (value[field] !== undefined && value[field] !== null) {
        throw new DirectResponsesRequestError(field, "Server-side conversation references are not supported");
      }
    }
  }
  const copied = structuredClone(value);
  return { ...copied, model, ...(copied.input === undefined ? {} : { input: copied.input as Exclude<DirectResponsesRequest["input"], undefined> }),
    stream: value.stream === true, store: false, ...(value.background === undefined ? {} : { background: false }) };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function applyResponsesReasoningPolicy(request: DirectResponsesRequest, provider: string, mode: "passthrough" | "off"): DirectResponsesRequest {
  if (mode === "passthrough") return request;
  if (!provider.startsWith("ds-") || !supportsChatReasoningOff(provider, request.model)) {
    throw new DirectResponsesRequestError("model", "Reasoning off is not supported for this provider and protocol");
  }
  for (const container of ["extra_body", "extraBody"]) {
    const nested = request[container];
    if (record(nested) && ["reasoning", "thinking", "reasoning_effort", "enable_thinking"].some(key => Object.hasOwn(nested, key))) {
      throw new DirectResponsesRequestError(container, "Conflicts with this key's reasoning-off policy");
    }
  }
  const result: DirectResponsesRequest = { ...request, reasoning: { ...(record(request.reasoning) ? request.reasoning : {}), effort: "none" } };
  for (const key of ["thinking", "reasoning_effort", "enable_thinking"]) delete result[key];
  return result;
}
