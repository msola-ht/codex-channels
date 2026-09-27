import { describe, expect, it } from "vitest";
import { GrammyError, HttpError } from "grammy";

import { telegramErrorMetadata } from "../src/surfaces/telegram/error-metadata.js";

describe("Telegram error metadata", () => {
  it("classifies unchanged edits without retaining response text or payload", () => {
    const error = new GrammyError("edit failed", {
      ok: false, error_code: 400, description: "Bad Request: message is not modified: secret",
    }, "editMessageText", { text: "private body" });
    expect(telegramErrorMetadata(error)).toEqual({
      errorType: "GrammyError", errorCode: 400, telegramReason: "message-not-modified",
    });
  });
  it("extracts a network failure code without retaining the HttpError URL or response", () => {
    const cause = Object.assign(new Error("secret response"), { code: "ECONNRESET" });
    expect(telegramErrorMetadata(new HttpError("secret bot URL", cause))).toEqual({
      errorType: "HttpError", causeType: "Error", causeCode: "ECONNRESET",
    });
  });
  it("does not retain arbitrary error messages or opaque credentials", () => {
    const error = new Error("request failed at /bot123456789:opaque-secret/file");
    error.name = "opaque-secret";
    const metadata = telegramErrorMetadata(error);

    expect(metadata).toEqual({ errorType: "Error" });
    expect(JSON.stringify(metadata)).not.toContain("opaque-secret");
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
