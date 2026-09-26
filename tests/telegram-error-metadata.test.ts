import { HttpError } from "grammy";
import { describe, expect, it } from "vitest";

import { telegramErrorMetadata } from "../src/surfaces/telegram/error-metadata.js";

describe("Telegram error metadata", () => {
  it("does not retain arbitrary error messages or opaque credentials", () => {
    const error = new Error("request failed at /bot123456789:opaque-secret/file");
    error.name = "opaque-secret";
    const metadata = telegramErrorMetadata(error);

    expect(metadata).toEqual({ errorType: "Error" });
    expect(JSON.stringify(metadata)).not.toContain("opaque-secret");
  });

  it("extracts allowlisted wrapped network causes without credentials", () => {
    const cause = Object.assign(new Error("https://api.telegram.org/bot123:secret"), { code: "ECONNRESET" });
    const error = new HttpError("Authorization: secret", new TypeError("secret", { cause }));
    expect(telegramErrorMetadata(error)).toEqual({ errorType: "HttpError", networkErrorType: "TypeError", networkCode: "ECONNRESET" });
    expect(JSON.stringify(telegramErrorMetadata(error))).not.toContain("secret");
  });

  it("bounds cyclic causes and excludes unrecognized nested fields", () => {
    const cause = Object.assign(new Error("secret"), { code: "SECRET_TOKEN", cause: {} });
    cause.cause = cause;
    expect(telegramErrorMetadata(new HttpError("secret", cause))).toEqual({ errorType: "HttpError", networkErrorType: "Error" });
  });

  it("retains only constrained machine-readable error codes", () => {
    const safe = Object.assign(new Error("secret"), { code: "ECONNRESET" });
    const unsafe = Object.assign(new Error("secret"), { code: "opaque-secret" });

    expect(telegramErrorMetadata(safe)).toEqual({
      errorType: "Error",
      errorCode: "ECONNRESET",
    });
    expect(telegramErrorMetadata(unsafe)).toEqual({ errorType: "Error" });
  });
});
