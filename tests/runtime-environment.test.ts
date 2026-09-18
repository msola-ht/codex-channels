import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  system: { https_proxy: "http://127.0.0.1:7890" },
}));

vi.mock("../scripts/runtime-config.mjs", () => ({
  requireUserConfig: () => ({ configPath: "/tmp/proxy-test/config.toml", dataDir: "/tmp/proxy-test" }),
  userDataDir: () => "/tmp/proxy-test",
}));
vi.mock("../runtime/gateway-config.mjs", () => ({
  readGatewayConfig: () => ({ network: { no_proxy: "localhost" }, codex: { binary: "codex" } }),
}));
vi.mock("../runtime/opencode-go-accounts.mjs", () => ({ migrateLegacyOpencodeGoAccount: () => undefined }));
vi.mock("../runtime/network-proxy.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/network-proxy.mjs")>();
  return {
    ...actual,
    resolveProxyEnvironment: (configured: object, environment: NodeJS.ProcessEnv) =>
      actual.resolveProxyEnvironment(configured, environment, { readSystemProxy: () => state.system }),
  };
});

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { configuredEnvironment } from "../scripts/runtime-environment.mjs";
import { createRefreshableHttpProxySelector } from "../runtime/network-proxy.mjs";

interface RuntimeEnvironment {
  environment: NodeJS.ProcessEnv;
  unresolvedProxyEnvironment: NodeJS.ProcessEnv;
}

describe("runtime environment proxy provenance", () => {
  it("does not promote a discovered system proxy to inherited configuration", () => {
    state.system = { https_proxy: "http://127.0.0.1:7890" };
    const runtime = configuredEnvironment({}) as RuntimeEnvironment;
    expect(runtime.environment.HTTPS_PROXY).toBe(state.system.https_proxy);
    expect(runtime.unresolvedProxyEnvironment.HTTPS_PROXY).toBeUndefined();
    const selector = createRefreshableHttpProxySelector({}, runtime.unresolvedProxyEnvironment, {
      readSystemProxy: () => state.system,
    });
    expect(selector.select("https://api.openai.com")).toBe("http://127.0.0.1:7890/");
    state.system = { https_proxy: "http://127.0.0.1:7891" };
    selector.invalidate();
    expect(selector.select("https://api.openai.com")).toBe("http://127.0.0.1:7891/");
  });

  it("preserves explicitly inherited proxy variables", () => {
    const runtime = configuredEnvironment({ HTTPS_PROXY: "http://explicit.test:8080" }) as RuntimeEnvironment;
    expect(runtime.unresolvedProxyEnvironment.HTTPS_PROXY).toBe("http://explicit.test:8080");
    expect(runtime.environment.HTTPS_PROXY).toBe("http://explicit.test:8080");
    expect(runtime.unresolvedProxyEnvironment.CODEX_CONNECT_CONFIG_FILE).toBe("/tmp/proxy-test/config.toml");
    expect(runtime.unresolvedProxyEnvironment.CODEX_BINARY).toBe("codex");
  });
});
