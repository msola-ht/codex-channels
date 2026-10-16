import type { ModelConversionError } from "./validation.js";
import type { RelayModelReasoning, RelayReasoningEffort } from "./chat-request.js";

type RequestError = new (param: string, reason: string) => ModelConversionError;

export function isRequestObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateDirectModel(value: unknown, ErrorType: RequestError): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new ErrorType("model", "Expected a nonempty model identifier of at most 200 characters");
  }
  return value;
}

export function validateDirectStream(value: unknown, ErrorType: RequestError): boolean {
  if (value !== undefined && typeof value !== "boolean") throw new ErrorType("stream", "Expected a boolean");
  return value === true;
}

export const reasoningControlFields = ["reasoning", "thinking", "reasoning_effort", "enable_thinking"] as const;

/** Explicit field selection is portable; the upstream decides whether it is supported. */
export function applyExplicitReasoningPolicy<T extends Record<string, unknown>>(
  request: T,
  mode: Exclude<RelayModelReasoning, "passthrough" | "off">,
  effortControl: (effort: RelayReasoningEffort) => Record<string, unknown>,
  ErrorType: RequestError,
): T {
  const result = clearReasoningControls(request, ErrorType);
  let control: Record<string, unknown>;
  switch (mode) {
    case "off-reasoning-effort": control = { reasoning: { effort: "none" } }; break;
    case "off-reasoning-enabled": control = { reasoning: { enabled: false } }; break;
    case "off-reasoning-enabled-thinking": control = { reasoning: { enabled: false }, thinking: { type: "disabled" } }; break;
    case "off-reasoning-effort-field": control = { reasoning_effort: "none" }; break;
    case "off-thinking": control = { thinking: { type: "disabled" } }; break;
    case "off-enable-thinking": control = { enable_thinking: false }; break;
    case "off-chat-template-thinking":
      control = { chat_template_kwargs: { ...(isRequestObject(result.chat_template_kwargs) ? result.chat_template_kwargs : {}), enable_thinking: false } }; break;
    case "off-google-thinking-budget": {
      const extra = isRequestObject(result.extra_body) ? result.extra_body : {};
      const google = isRequestObject(extra.google) ? extra.google : {};
      control = { extra_body: { ...extra, google: { ...google, thinking_config: { thinking_budget: 0 } } } }; break;
    }
    case "minimal": case "low": case "medium": case "high": case "xhigh": case "max":
      control = effortControl(mode); break;
    default: throw new ErrorType("reasoning", "Unsupported reasoning policy");
  }
  return Object.assign(result, control);
}

/** Remove only reasoning controls; retain unrelated template and provider options. */
export function clearReasoningControls<T extends Record<string, unknown>>(request: T, ErrorType: RequestError): T {
  assertNoNestedReasoningControls(request, ErrorType);
  const result = { ...request };
  for (const field of reasoningControlFields) delete result[field];
  const object = (value: unknown, path: string): Record<string, unknown> => {
    if (!isRequestObject(value)) throw new ErrorType(path, "Expected an object for the enforced reasoning policy");
    return { ...value };
  };
  if (Object.hasOwn(request, "chat_template_kwargs")) {
    const template = object(request.chat_template_kwargs, "chat_template_kwargs");
    delete template.enable_thinking;
    Object.assign(result, { chat_template_kwargs: template });
  }
  if (Object.hasOwn(request, "extra_body")) {
    const extra = object(request.extra_body, "extra_body");
    if (Object.hasOwn(extra, "google")) {
      const google = object(extra.google, "extra_body.google");
      delete google.thinking_config;
      extra.google = google;
    }
    Object.assign(result, { extra_body: extra });
  }
  return result;
}

export function assertNoNestedReasoningControls(request: Record<string, unknown>, ErrorType: RequestError): void {
  for (const container of ["extra_body", "extraBody"]) {
    const nested = request[container];
    if (isRequestObject(nested)) for (const field of reasoningControlFields) {
      if (Object.hasOwn(nested, field)) throw new ErrorType(`${container}.${field}`, "Conflicts with the enforced reasoning policy");
    }
    if (isRequestObject(nested) && isRequestObject(nested.chat_template_kwargs)
      && Object.hasOwn(nested.chat_template_kwargs, "enable_thinking")) {
      throw new ErrorType(`${container}.chat_template_kwargs.enable_thinking`, "Conflicts with the enforced reasoning policy");
    }
    if (container === "extraBody" && isRequestObject(nested) && isRequestObject(nested.google)
      && Object.hasOwn(nested.google, "thinking_config")) {
      throw new ErrorType(`${container}.google.thinking_config`, "Conflicts with the enforced reasoning policy");
    }
  }
}
