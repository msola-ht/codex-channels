import { GrammyError, HttpError } from "grammy";
import { describe, expect, it } from "vitest";

import { telegramErrorMetadata } from "../src/surfaces/telegram/error-metadata.js";

describe("Telegram error metadata", () => {
  it.each([
    ["message is not modified", "message_not_modified"],
    ["message to edit not found", "message_not_found"],
    ["message can't be edited", "message_not_editable"],
    ["can't parse entities: secret", "invalid_entities"],
    ["message is too long", "message_too_long"],
    ["opaque-secret", "bad_request"],
  ])("classifies %s without retaining upstream descriptions", (description, kind) => {
    const error = new GrammyError("secret", { ok: false, error_code: 400, description: `Bad Request: ${description}` }, "editMessageText", {});
    expect(telegramErrorMetadata(error)).toMatchObject({ errorCode: 400, telegramErrorKind: kind });
    expect(JSON.stringify(telegramErrorMetadata(error))).not.toContain("secret");
  });
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
