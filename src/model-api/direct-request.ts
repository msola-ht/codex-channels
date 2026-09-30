import type { ModelConversionError } from "./validation.js";

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

export function assertNoNestedReasoningControls(request: Record<string, unknown>, ErrorType: RequestError): void {
  for (const container of ["extra_body", "extraBody"]) {
    const nested = request[container];
    if (isRequestObject(nested)) for (const field of reasoningControlFields) {
      if (Object.hasOwn(nested, field)) throw new ErrorType(`${container}.${field}`, "Conflicts with this key's reasoning-off policy");
    }
  }
}
