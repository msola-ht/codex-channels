import { describe, expect, it } from "vitest";

// @ts-expect-error JavaScript service runtime intentionally has no declaration file.
import { applyAppServerTimezone, resolveExternalRoleReasoningEffort, runAppServerService } from "../runtime/app-server-service-runtime.mjs";

describe("App Server service runtime", () => {
  it("uses the managed model catalog as the external role metrics reasoning source", () => {
    expect(resolveExternalRoleReasoningEffort({
      provider: "ccg-main",
      providerType: "managed",
      model: "deepseek/deepseek-v4-flash",
      reasoningEffort: "max",
    }, [{
      provider: "ccg-main",
      models: [{ model: "deepseek/deepseek-v4-flash", reasoningEffort: "high" }],
    }])).toBe("high");
    expect(resolveExternalRoleReasoningEffort({
      provider: "custom",
      providerType: "custom",
      model: "gpt-custom",
      reasoningEffort: "medium",
    }, [])).toBe("medium");
    expect(() => resolveExternalRoleReasoningEffort({
      provider: "ccg-main",
      providerType: "managed",
      model: "missing-model",
      reasoningEffort: "high",
    }, [{ provider: "ccg-main", models: [] }])).toThrow("当前模型目录");
  });

  it("only sets the process timezone when it is configured", () => {
    const inherited = { TZ: "Asia/Shanghai", PATH: "/usr/bin" };
    applyAppServerTimezone(inherited, undefined);
    expect(inherited).toEqual({ TZ: "Asia/Shanghai", PATH: "/usr/bin" });

    applyAppServerTimezone(inherited, "America/Los_Angeles");
    expect(inherited.TZ).toBe("America/Los_Angeles");
  });

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
