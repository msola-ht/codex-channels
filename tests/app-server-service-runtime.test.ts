import { describe, expect, it } from "vitest";

// @ts-expect-error JavaScript service runtime intentionally has no declaration file.
import { runAppServerService } from "../runtime/app-server-service-runtime.mjs";

describe("App Server service runtime", () => {
  it("rejects enabled Desktop App sharing on unsupported platforms before startup", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      ...platform,
      value: "linux",
    });
    try {
      await expect(runAppServerService({
        document: {
          codex: {
            desktop_app: { enabled: true, port: 49_204 },
          },
        },
        environment: {},
        dataDir: "/tmp/codexc-unsupported-desktop-app",
      }, () => {
        throw new Error("不应继续解析默认 Workspace");
      })).rejects.toThrow("Codex Desktop App 共享当前只支持 macOS 与 Windows");
    } finally {
      Object.defineProperty(process, "platform", platform ?? {
        value: process.platform,
        configurable: true,
      });
    }
  });
});
