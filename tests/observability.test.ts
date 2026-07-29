import { describe, expect, it } from "vitest";

import {
  createLogger,
  safeErrorMetadata,
} from "../src/observability/index.js";

describe("createLogger", () => {
  it("summarizes unknown process errors without exposing their contents", () => {
    const error = Object.assign(new Error("Authorization Bearer secret"), {
      name: "opaque-secret",
      code: "unsafe-secret",
      responseBody: "token=secret",
    });

    expect(safeErrorMetadata(error)).toEqual({
      type: "Error",
    });
  });

  it("logs only constrained metadata for Error objects", () => {
    const secret = "opaque-upstream-secret";
    const record = captureLog(() => {
      const logger = createLogger({ logLevel: "info" });
      logger.error({
        err: Object.assign(
          new Error(`request failed: Authorization Bearer ${secret}`),
          {
            code: "ECONNRESET",
            responseBody: `token=${secret}`,
          },
        ),
      }, "请求失败");
    });

    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record.err).toEqual({
      type: "Error",
      code: "ECONNRESET",
    });
  });

  it("redacts credential fields and authentication headers", () => {
    const secret = "credential-secret";
    const record = captureLog(() => {
      const logger = createLogger({ logLevel: "info" });
      logger.info({
        token: secret,
        password: secret,
        appSecret: secret,
        app_secret: secret,
        feishu: {
          appSecret: secret,
          app_secret: secret,
        },
        cookie: secret,
        authorization: secret,
        headers: {
          authorization: secret,
          cookie: secret,
        },
        req: {
          headers: {
            authorization: secret,
            cookie: secret,
          },
        },
      }, "配置检查");
    });

    expect(JSON.stringify(record)).not.toContain(secret);
  });
});

function captureLog(write: () => void): Record<string, unknown> {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    write();
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output) as Record<string, unknown>;
}
