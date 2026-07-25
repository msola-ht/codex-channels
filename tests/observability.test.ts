import { describe, expect, it } from "vitest";

import { createLogger } from "../src/observability/index.js";

describe("createLogger", () => {
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
