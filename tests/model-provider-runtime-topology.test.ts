import {
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveAppServerRuntime,
  resolvePrimaryAppServerSocketPath,
} from "../runtime/app-server-runtime.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadManagedModelProvider,
  loadManagedModelProviders,
  loadManagedProviderAppServer,
  loadManagedProviderAppServers,
  loadOpenAiBaseUrl,
  loadPrimaryModelProvider,
  managedModelProviderRoleConfigPath,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
  validateConfiguredModelProvider,
  validateConfiguredModelProviders,
  withOpenAiBaseUrl,
  withProviderBaseUrl,
  writeManagedModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import {
  configuredHome,
  configureOpenCodeGo,
  connectHomeFor,
  testEnvironment,
} from "./model-provider-runtime-test-fixture.js";

describe("model provider App Server topology", () => {
  it("resolves the primary socket from one shared runtime descriptor", () => {
    expect(resolvePrimaryAppServerSocketPath(
      { codex: { socket_path: "runtime/custom.sock" } },
      "/private/codexc",
    )).toBe(resolve("/private/codexc/runtime/custom.sock"));
  });

  it("describes the complete switching topology from one shared source", async () => {
    const codexHome = await configuredHome("switching");
    const descriptor = resolveAppServerRuntime(
      { codex: { socket_path: "runtime/codex.sock" } },
      "/private/codexc",
      testEnvironment(codexHome),
    );

    expect(descriptor.primaryProvider).toBe("openai");
    expect(descriptor.managedProviders[0]?.provider).toBe("deepseek");
    expect(descriptor.socketPaths).toEqual([
      resolve("/private/codexc/runtime/codex.sock"),
      resolve("/private/codexc/runtime/codex-deepseek.sock"),
    ]);
    expect(descriptor.topology).toEqual({
      primaryProvider: "openai",
      managedProviders: ["deepseek"],
      socketPaths: descriptor.socketPaths,
    });
  });

  it("keeps DeepSeek and OpenCode Go as independent managed Providers", async () => {
    const codexHome = await configuredHome("switching");
    configureOpenCodeGo(codexHome);
    const environment = testEnvironment(codexHome);

    expect(loadManagedModelProviders(environment)).toEqual([
      { provider: "deepseek" },
      { provider: "ocg-main" },
    ]);
    expect(loadManagedProviderAppServers(environment).map((provider) => ({
      provider: provider.provider,
      environmentKeys: Object.keys(provider.childEnvironment),
      retryPolicy: provider.arguments.filter((argument) =>
        argument.includes("_max_retries=")),
    }))).toEqual([{
      provider: "deepseek",
      environmentKeys: ["CODEX_CONNECT_DEEPSEEK_API_KEY"],
      retryPolicy: [
        "model_providers.deepseek.request_max_retries=1",
        "model_providers.deepseek.stream_max_retries=0",
      ],
    }, {
      provider: "ocg-main",
      environmentKeys: ["CODEX_CONNECT_OPENCODE_GO_MAIN_API_KEY"],
      retryPolicy: [
        "model_providers.ocg-main.request_max_retries=1",
        "model_providers.ocg-main.stream_max_retries=0",
      ],
    }]);
    expect(validateConfiguredModelProviders(environment)).toEqual([
      { provider: "deepseek", mode: "switching" },
      { provider: "ocg-main", mode: "switching" },
    ]);

    writeManagedModelProviderRoleConfig(environment, { provider: "deepseek" });
    expect(readFileSync(managedModelProviderRoleConfigPath(environment), "utf8"))
      .toContain('model_provider = "deepseek"');
    expect(readFileSync(managedModelProviderRoleConfigPath(environment), "utf8"))
      .toContain("request_max_retries = 1");
  });

  it("uses OpenAI as primary and exposes DeepSeek as an auxiliary switching server", async () => {
    const codexHome = await configuredHome("switching");
    const environment = testEnvironment(codexHome);

    expect(loadPrimaryModelProvider(environment)).toBe("openai");
    expect(loadManagedModelProvider(environment)).toMatchObject({ provider: "deepseek" });
  });

  it("keeps an inactive custom Provider on the stable OpenAI primary topology", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-primary-"));
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.6-terra"',
      "",
      "[model_providers.thirdparty]",
      'name = "Third-party Responses"',
      'base_url = "https://proxy.example.test/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "supports_websockets = false",
      "",
    ].join("\n"), { mode: 0o600 });
    const environment = testEnvironment(codexHome);

    expect(loadConfiguredCustomPrimaryModelProvider(environment)).toEqual({
      id: "thirdparty",
      baseUrl: "https://proxy.example.test/v1",
    });
    expect(loadPrimaryModelProvider(environment)).toBe("openai");
    expect(resolveAppServerRuntime(
      { codex: { socket_path: "runtime/codex.sock" } },
      "/private/codexc",
      environment,
    ).topology.primaryProvider).toBe("openai");
  });

  it("uses the native DeepSeek configuration as the only primary server in exclusive mode", async () => {
    const codexHome = await configuredHome("exclusive");
    const environment = testEnvironment(codexHome);

    expect(loadPrimaryModelProvider(environment)).toBe("deepseek");
    expect(loadManagedModelProvider(environment)).toBeUndefined();
  });

  it("uses OpenCode Go as the primary server in exclusive mode", async () => {
    const codexHome = await configuredHome("switching");
    rmSync(join(connectHomeFor(codexHome), "providers", "deepseek", "managed.toml"));
    rmSync(join(codexHome, "sf-deepseek.config.toml"));
    configureOpenCodeGo(codexHome, "exclusive");
    const environment = testEnvironment(codexHome);

    expect(loadPrimaryModelProvider(environment)).toBe("ocg-main");
    expect(loadManagedModelProvider(environment)).toBeUndefined();
    expect(validateConfiguredModelProvider(environment))
      .toEqual({ provider: "ocg-main", mode: "exclusive" });
  });

  it("rejects more than one exclusive third-party Provider", async () => {
    const codexHome = await configuredHome("exclusive");
    configureOpenCodeGo(codexHome, "exclusive");
    const environment = testEnvironment(codexHome);

    expect(() => loadPrimaryModelProvider(environment))
      .toThrow("只能有一个受管第三方 Provider 使用固定模式");
    expect(() => validateConfiguredModelProviders(environment))
      .toThrow("只能有一个受管第三方 Provider 使用固定模式");
  });

  it("derives a private sibling socket without changing the configured primary socket", () => {
    expect(providerAppServerSocketPath(
      "/private/runtime/codex-app-server.sock",
      "deepseek",
    )).toBe(resolve("/private/runtime/codex-app-server-deepseek.sock"));
  });

  it("derives a private metrics socket beside the provider App Server socket", () => {
    expect(providerMetricsSocketPath(
      "/private/runtime/codex-app-server.sock",
      "deepseek",
    )).toBe(resolve("/private/runtime/codex-app-server-deepseek-metrics.sock"));
  });

  it("preserves a configured OpenAI base URL behind the local metrics proxy", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "config.toml"),
      'openai_base_url = "https://regional.example.test/codex"\n',
      { mode: 0o600 },
    );

    expect(loadOpenAiBaseUrl(testEnvironment(codexHome)))
      .toBe("https://regional.example.test/codex");
    expect(withOpenAiBaseUrl([], "http://127.0.0.1:45678"))
      .toEqual(["-c", 'openai_base_url="http://127.0.0.1:45678"']);
  });

  it("does not invent an OpenAI base URL when config.toml does not declare one", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n', {
      mode: 0o600,
    });

    expect(loadOpenAiBaseUrl(testEnvironment(codexHome))).toBeUndefined();
  });

  it("replaces the managed provider base URL with a local proxy address", async () => {
    const codexHome = await configuredHome("switching");
    const environment = testEnvironment(codexHome);
    const managed = loadManagedProviderAppServer(environment);
    if (!managed) {
      throw new Error("测试环境缺少 DeepSeek 托管配置");
    }
    expect(managed.arguments).toContain(
      "model_providers.deepseek.base_url=\"https://api.deepseek.com/\"",
    );
    expect(managed.arguments).toContain('model_reasoning_effort="high"');
    expect(managed.arguments).not.toContain("model_auto_compact_token_limit=629146");

    const overridden = withProviderBaseUrl(
      managed.arguments,
      managed.provider,
      "http://127.0.0.1:38473/",
    );

    expect(overridden).not.toContain(
      "model_providers.deepseek.base_url=\"https://api.deepseek.com/\"",
    );
    expect(overridden).toContain(
      "model_providers.deepseek.base_url=\"http://127.0.0.1:38473/\"",
    );
    expect(overridden).toContain("model_providers.deepseek.request_max_retries=1");
    expect(overridden).toContain("model_providers.deepseek.stream_max_retries=0");
    expect(overridden.at(-2)).toBe("-c");
    expect(overridden.some((value, index) =>
      value === "-c" && overridden[index + 1] === "-c"
    )).toBe(false);
  });

});
