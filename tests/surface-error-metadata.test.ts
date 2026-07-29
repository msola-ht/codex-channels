import { describe, expect, it } from "vitest";

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
});
