/** Errors deliberately contain no upstream payload or user content. */
export class ModelConversionError extends Error {
  constructor(message = "Unsupported or invalid model API payload") {
    super(message);
    this.name = "ModelConversionError";
  }
}
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConversionError();
  return value as JsonObject;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new ModelConversionError();
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ModelConversionError();
  return value;
}
