import { describe, expect, it } from "vitest";

import { JsonRpcError } from "../src/codex-client/index.js";
import { surfaceErrorMetadata } from "../src/surfaces/index.js";

describe("surfaceErrorMetadata", () => {
  it("keeps only constrained error types and machine-readable codes", () => {
    const unsafe = Object.assign(new Error("Authorization Bearer secret"), {
      name: "opaque-secret",
      code: "unsafe-secret",
      responseBody: "token=secret",
    });

    expect(surfaceErrorMetadata(unsafe)).toEqual({
      errorType: "Error",
    });
    expect(surfaceErrorMetadata(Object.assign(new Error("secret"), {
      code: "ECONNRESET",
    }))).toEqual({
      errorType: "Error",
      errorCode: "ECONNRESET",
    });
    expect(surfaceErrorMetadata({
      error_code: 42,
      message: "secret",
    })).toEqual({
      errorType: "object",
      errorCode: 42,
    });
  });

  it("classifies only locked App Server turn-steer errors without logging details", () => {
    const noActiveTurn = new JsonRpcError(-32600, "no active turn to steer");
    const mismatch = new JsonRpcError(
      -32600,
      "expected active turn id `turn-secret-1` but found `turn-secret-2`",
    );
    const unknown = new JsonRpcError(-32600, "Authorization Bearer secret");

    expect(surfaceErrorMetadata(noActiveTurn)).toEqual({
      errorType: "JsonRpcError",
      errorCode: -32600,
      errorReason: "no-active-turn",
    });
    expect(surfaceErrorMetadata(mismatch)).toEqual({
      errorType: "JsonRpcError",
      errorCode: -32600,
      errorReason: "expected-turn-mismatch",
    });
    expect(surfaceErrorMetadata(unknown)).toEqual({
      errorType: "JsonRpcError",
      errorCode: -32600,
    });
    expect(JSON.stringify(surfaceErrorMetadata(mismatch))).not.toContain(
      "turn-secret",
    );
    expect(JSON.stringify(surfaceErrorMetadata(unknown))).not.toContain(
      "Bearer",
    );
  });
});
