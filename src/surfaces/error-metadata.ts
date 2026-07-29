export interface SurfaceErrorMetadata extends Record<string, unknown> {
  errorType: string;
  errorCode?: string | number;
}

export function surfaceErrorMetadata(error: unknown): SurfaceErrorMetadata {
  const constructorName = error instanceof Error
    ? error.constructor.name
    : undefined;
  const errorType = typeof constructorName === "string"
    && /^[A-Za-z][A-Za-z0-9]{0,40}$/u.test(constructorName)
    ? constructorName
    : error instanceof Error
      ? "Error"
      : error === null
        ? "null"
        : typeof error;
  if (typeof error !== "object" || error === null) {
    return { errorType };
  }
  const record = error as Record<string, unknown>;
  if (
    typeof record.error_code === "number"
    && Number.isSafeInteger(record.error_code)
  ) {
    return { errorType, errorCode: record.error_code };
  }
  if (
    typeof record.code === "string"
    && /^[A-Z][A-Z0-9_]{1,40}$/u.test(record.code)
  ) {
    return { errorType, errorCode: record.code };
  }
  return { errorType };
}
