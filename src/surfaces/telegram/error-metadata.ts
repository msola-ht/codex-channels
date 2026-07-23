export interface TelegramErrorMetadata {
  errorType: string;
  errorCode?: string | number;
}

export function telegramErrorMetadata(error: unknown): TelegramErrorMetadata {
  const constructorName = error instanceof Error
    ? error.constructor.name
    : undefined;
  const errorType = typeof constructorName === "string"
    && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(constructorName)
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
  const numericCode = record.error_code;
  if (typeof numericCode === "number" && Number.isSafeInteger(numericCode)) {
    return { errorType, errorCode: numericCode };
  }
  const code = record.code;
  if (
    typeof code === "string"
    && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)
  ) {
    return { errorType, errorCode: code };
  }
  return { errorType };
}
