import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import { secureTestDirectory, secureTestFile } from "./support/windows-fixtures.js";

const runtimeFileFailures = vi.hoisted(() => ({
  unlinkPath: undefined as string | undefined,
  atomicWritePath: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (path: string) => {
      if (path === runtimeFileFailures.unlinkPath) {
        throw new Error("injected Profile deletion failure");
      }
      return actual.unlinkSync(path);
    },
  };
});

vi.mock("../runtime/private-file.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/private-file.mjs")>();
  return {
    ...actual,
    writePrivateFileAtomicSync: (path: string, content: string) => {
      if (path === runtimeFileFailures.atomicWritePath) {
        throw new Error("injected registry rollback failure");
      }
      return actual.writePrivateFileAtomicSync(path, content);
    },
    assertPrivateFileAccessSync: () => undefined,
    assertPrivateDirectoryAccessSync: () => undefined,
    readPrivateFileSync: (path: string) => readFileSync(path, "utf8"),
  };
});

import {
  resolveAppServerRuntime,
  resolvePrimaryAppServerSocketPath,
} from "../runtime/app-server-runtime.mjs";
import {
  customPrimaryProviderProfilePath,
  loadManagedModelProvider,
  loadManagedModelProviderRole,
  loadManagedModelProviders,
  loadManagedProviderAppServer,
  loadManagedProviderAppServers,
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomSwitchingModelProviders,
  loadCustomModelProviderRoleCandidates,
  loadCustomSwitchingProviderIds,
  customSwitchingProviderRegistryPath,
  loadOpenAiBaseUrl,
  loadPrimaryModelProvider,
  loadThirdPartyModelProviderRole,
  loadThirdPartyProviderCredential,
  managedModelProviderRoleConfigPath,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
  removeCustomPrimaryProviderSwitchingProfile,
  removeManagedModelProviderRoleConfig,
  validateCustomPrimaryModelProviderId,
  validateConfiguredModelProvider,
  validateConfiguredModelProviders,
  withProviderBaseUrl,
  withOpenAiBaseUrl,
  writeCustomPrimaryProviderSwitchingProfile,
  writeManagedModelProviderProfileDefault,
  writeManagedModelProviderRoleConfig,
  writeThirdPartyModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import {
  loadOpencodeGoAccounts,
  migrateLegacyOpencodeGoAccount,
  opencodeGoAccountsFilePath,
  opencodeGoAccountMarkerPath,
  readOpencodeGoAccountMarker,
} from "../runtime/opencode-go-accounts.mjs";

describe("model provider runtime topology", () => {
  it("rejects reserved Codex provider IDs as custom primary candidates", () => {
    const environment = testEnvironment(tmpdir());
    for (const id of [
      "openai",
      "ollama",
      "lmstudio",
      "amazon-bedrock",
      "opencode-go-custom",
    ]) {
      expect(validateCustomPrimaryModelProviderId(id, environment))
        .toBe("该 Provider ID 已被 Codex 或 Gateway 保留");
    }
  });

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
      { provider: "opencode-go" },
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
      provider: "opencode-go",
      environmentKeys: ["CODEX_CONNECT_OPENCODE_GO_API_KEY"],
      retryPolicy: [
        "model_providers.opencode-go.request_max_retries=1",
        "model_providers.opencode-go.stream_max_retries=0",
      ],
    }]);
    expect(validateConfiguredModelProviders(environment)).toEqual([
      { provider: "deepseek", mode: "switching" },
      { provider: "opencode-go", mode: "switching" },
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

  it("adds a custom switching Provider as an isolated App Server using the official catalog", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-"));
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "OpenAI",
      model: "gpt-5.6-sol",
      name: "OpenAI",
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "sk-test",
      supportsWebsockets: true,
    }, environment);

    expect(loadConfiguredCustomSwitchingModelProviders(environment)[0]).toMatchObject({
      id: "OpenAI",
      provider: "OpenAI",
      model: "gpt-5.6-sol",
      baseUrl: "https://proxy.example.test/v1",
      profileName: "sf-custom-OpenAI",
      catalogSource: { kind: "official" },
      arguments: [
        "-c", 'model="gpt-5.6-sol"',
        "-c", 'model_provider="OpenAI"',
        "-c", 'service_tier="default"',
        "-c", 'model_reasoning_effort="medium"',
        "-c", 'model_providers.OpenAI.name="OpenAI"',
        "-c", 'model_providers.OpenAI.base_url="https://proxy.example.test/v1"',
        "-c", 'model_providers.OpenAI.wire_api="responses"',
        "-c", expect.stringMatching(/^model_providers\.OpenAI\.env_key=/u),
        "-c", "model_providers.OpenAI.requires_openai_auth=false",
        "-c", "model_providers.OpenAI.supports_websockets=true",
        "-c", "model_providers.OpenAI.request_max_retries=1",
        "-c", "model_providers.OpenAI.stream_max_retries=0",
      ],
    });
    const childEnvironment = loadConfiguredCustomSwitchingModelProviders(environment)[0]
      ?.childEnvironment;
    expect(Object.keys(childEnvironment ?? {})).toEqual([
      expect.stringMatching(/^CODEX_CONNECT_CUSTOM_/u),
    ]);
    expect(Object.values(childEnvironment ?? {})).toEqual(["sk-test"]);

    const descriptor = resolveAppServerRuntime(
      { codex: { socket_path: "runtime/codex.sock" } },
      "/private/codexc",
      environment,
    );
    expect(descriptor.primaryProvider).toBe("openai");
    expect(descriptor.managedProviders).toEqual([
      expect.objectContaining({ provider: "OpenAI", model: "gpt-5.6-sol" }),
    ]);
    expect(descriptor.customSwitchingProviders).toEqual([
      expect.objectContaining({ provider: "OpenAI", model: "gpt-5.6-sol" }),
    ]);
    expect(descriptor.topology.managedProviders).toEqual(["OpenAI"]);
    expect(descriptor.socketPaths).toContain(
      providerAppServerSocketPath("/private/codexc/runtime/codex.sock", "OpenAI"),
    );
  });

  it("loads multiple custom switching Providers from independent private Profiles", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-many-"));
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "proxy-a",
      model: "gpt-5.6-sol",
      name: "Proxy A",
      baseUrl: "https://a.example.test/v1",
      apiKey: "sk-a",
      supportsWebsockets: false,
    }, environment);
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "proxy-b",
      model: "gpt-5.6-terra",
      name: "Proxy B",
      baseUrl: "https://b.example.test/v1",
      apiKey: "sk-b",
      supportsWebsockets: true,
    }, environment);

    expect(loadConfiguredCustomSwitchingModelProviders(environment).map((provider) => ({
      provider: provider.provider,
      profileName: provider.profileName,
      effort: provider.reasoningEffort,
    }))).toEqual([
      {
        provider: "proxy-a",
        profileName: "sf-custom-proxy-a",
        effort: "medium",
      },
      {
        provider: "proxy-b",
        profileName: "sf-custom-proxy-b",
        effort: "medium",
      },
    ]);
    expect(resolveAppServerRuntime(
      { codex: { socket_path: "runtime/codex.sock" } },
      "/private/codexc",
      environment,
    ).topology.managedProviders).toEqual(["proxy-a", "proxy-b"]);

    rmSync(customPrimaryProviderProfilePath(environment, "proxy-a"));
    expect(removeCustomPrimaryProviderSwitchingProfile(environment, "proxy-a")).toBe(true);
    expect(loadCustomSwitchingProviderIds(environment)).toEqual(["proxy-b"]);
    expect(existsSync(customPrimaryProviderProfilePath(environment, "proxy-b"))).toBe(true);
  });

  it("rejects a registered custom switching Provider whose Profile is missing", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-missing-"));
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    mkdirSync(join(environment.CODEX_CONNECT_HOME!, "providers", "custom"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(customSwitchingProviderRegistryPath(environment), '[{"id":"proxy-a"}]\n', {
      mode: 0o600,
    });

    expect(() => loadConfiguredCustomSwitchingModelProviders(environment))
      .toThrow("自定义切换 Provider proxy-a 的 Profile 缺失");
  });

  it("rejects unknown fields in the custom switching Provider registry", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-registry-field-"));
    const environment = testEnvironment(codexHome);
    mkdirSync(join(environment.CODEX_CONNECT_HOME!, "providers", "custom"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      customSwitchingProviderRegistryPath(environment),
      '[{"id":"proxy-a","unexpected":true}]\n',
      { mode: 0o600 },
    );

    expect(() => loadCustomSwitchingProviderIds(environment))
      .toThrow("注册表包含重复或无效 Provider");
  });

  it("preserves both failures when Profile deletion and registry rollback fail", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-remove-failure-"));
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "proxy-a",
      model: "gpt-5.6-sol",
      name: "Proxy A",
      baseUrl: "https://a.example.test/v1",
      apiKey: "sk-a",
    }, environment);
    runtimeFileFailures.unlinkPath = customPrimaryProviderProfilePath(environment, "proxy-a");
    runtimeFileFailures.atomicWritePath = customSwitchingProviderRegistryPath(environment);

    try {
      expect(() => removeCustomPrimaryProviderSwitchingProfile(environment, "proxy-a"))
        .toThrow(expect.objectContaining({
          name: "AggregateError",
          message: "自定义切换 Provider Profile 删除失败，且注册表回滚失败",
        }));
    } finally {
      runtimeFileFailures.unlinkPath = undefined;
      runtimeFileFailures.atomicWritePath = undefined;
    }
  });

  it("rejects additional Provider blocks in a custom switching Profile", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-extra-provider-"));
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    mkdirSync(join(environment.CODEX_CONNECT_HOME!, "providers", "custom"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(customSwitchingProviderRegistryPath(environment), '[{"id":"proxy-a"}]\n', {
      mode: 0o600,
    });
    writeFileSync(customPrimaryProviderProfilePath(environment, "proxy-a"), [
      'model = "gpt-5.6-sol"',
      'model_provider = "proxy-a"',
      'model_reasoning_effort = "medium"',
      'service_tier = "default"',
      "",
      "[model_providers.proxy-a]",
      'name = "Proxy A"',
      'base_url = "https://a.example.test/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      'experimental_bearer_token = "sk-a"',
      "",
      "[model_providers.proxy-b]",
      'base_url = "https://b.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(() => loadConfiguredCustomSwitchingModelProviders(environment))
      .toThrow("Profile 只能包含已注册的 Provider 块");
  });

  it("rejects unsupported fields in a custom switching Provider block", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-provider-field-"));
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    mkdirSync(join(environment.CODEX_CONNECT_HOME!, "providers", "custom"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(customSwitchingProviderRegistryPath(environment), '[{"id":"proxy-a"}]\n', {
      mode: 0o600,
    });
    writeFileSync(customPrimaryProviderProfilePath(environment, "proxy-a"), [
      'model = "gpt-5.6-sol"',
      'model_provider = "proxy-a"',
      'model_reasoning_effort = "medium"',
      'service_tier = "default"',
      "",
      "[model_providers.proxy-a]",
      'name = "Proxy A"',
      'base_url = "https://a.example.test/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      'experimental_bearer_token = "sk-a"',
      'env_key = "UNMANAGED_PROXY_KEY"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(() => loadConfiguredCustomSwitchingModelProviders(environment))
      .toThrow("Provider 块包含不受支持的配置");
  });

  it("rejects a custom switching Profile that selects a custom model catalog", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-catalog-"));
    writeFileSync(join(codexHome, "config.toml"), "", { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    mkdirSync(join(environment.CODEX_CONNECT_HOME!, "providers", "custom"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(customSwitchingProviderRegistryPath(environment), '[{"id":"thirdparty"}]\n', { mode: 0o600 });
    writeFileSync(customPrimaryProviderProfilePath(environment, "thirdparty"), [
      'model = "model-a"',
      'model_provider = "thirdparty"',
      'model_catalog_json = "/tmp/models.json"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(() => loadConfiguredCustomSwitchingModelProviders(environment))
      .toThrow("当前只支持 Codex 官方模型目录");
  });

  it("rejects unsupported fields in the reserved custom switching Profile", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-field-"));
    writeFileSync(join(codexHome, "config.toml"), "", { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    mkdirSync(join(environment.CODEX_CONNECT_HOME!, "providers", "custom"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(customSwitchingProviderRegistryPath(environment), '[{"id":"thirdparty"}]\n', { mode: 0o600 });
    writeFileSync(customPrimaryProviderProfilePath(environment, "thirdparty"), [
      'model = "model-a"',
      'model_provider = "thirdparty"',
      'service_tier = "default"',
      'model_reasoning_effort = "high"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(() => loadConfiguredCustomSwitchingModelProviders(environment))
      .toThrow("Profile 包含不受支持的配置");
  });

  it("rejects a custom switching Provider together with a top-level OpenAI base URL", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-openai-url-"));
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "openai"',
      'openai_base_url = "https://official-proxy.example.test/v1"',
      "[model_providers.thirdparty]",
      'base_url = "https://third.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-a",
      name: "Third Party",
      baseUrl: "https://third.example.test/v1",
      apiKey: "sk-test",
    }, environment);

    expect(() => loadConfiguredCustomSwitchingModelProviders(environment))
      .toThrow("openai_base_url 与自定义 Provider 切换模式不能同时配置");
  });

  it("rejects a selected custom Provider without a valid Responses endpoint", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-primary-invalid-"));
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "thirdparty"',
      "",
      "[model_providers.thirdparty]",
      'base_url = "ftp://proxy.example.test/v1"',
      'wire_api = "chat_completions"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(() => loadPrimaryModelProvider(testEnvironment(codexHome)))
      .toThrow("base_url 必须是无凭据、查询和片段的 HTTP(S) URL");
  });

  it("keeps the official primary when multiple candidates have no explicit selection", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-primary-ambiguous-"));
    writeFileSync(join(codexHome, "config.toml"), [
      "[model_providers.first]",
      'base_url = "https://first.example.test/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.second]",
      'base_url = "https://second.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(loadConfiguredCustomPrimaryModelProvider(testEnvironment(codexHome)))
      .toBeUndefined();
  });

  it("activates the explicitly selected candidate among multiple blocks", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-primary-selected-ambiguous-"));
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "first"',
      "",
      "[model_providers.first]",
      'base_url = "https://first.example.test/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.second]",
      'base_url = "https://second.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(loadConfiguredCustomPrimaryModelProvider(testEnvironment(codexHome)))
      .toEqual({
        id: "first",
        baseUrl: "https://first.example.test/v1",
      });
  });

  it("keeps the official primary when openai is explicitly selected even with one candidate", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-primary-explicit-openai-"));
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "openai"',
      "",
      "[model_providers.only]",
      'base_url = "https://only.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(loadConfiguredCustomPrimaryModelProvider(testEnvironment(codexHome)))
      .toBeUndefined();
  });

  it("rejects a custom primary Provider together with a top-level official base URL", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-primary-top-level-url-"));
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "thirdparty"',
      'openai_base_url = "https://api.openai.com/v1"',
      "",
      "[model_providers.thirdparty]",
      'base_url = "https://third.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(() => loadConfiguredCustomPrimaryModelProvider(testEnvironment(codexHome)))
      .toThrow("官方顶层 openai_base_url 与自定义主 Provider 不能同时配置");
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

    expect(loadPrimaryModelProvider(environment)).toBe("opencode-go");
    expect(loadManagedModelProvider(environment)).toBeUndefined();
    expect(validateConfiguredModelProvider(environment))
      .toEqual({ provider: "opencode-go", mode: "exclusive" });
  });

  it("migrates the legacy single-account layout to the default account", async () => {
    const codexHome = await configuredHome("switching");
    configureLegacyOpenCodeGo(codexHome);
    const environment = testEnvironment(codexHome);

    expect(migrateLegacyOpencodeGoAccount(environment)).toEqual({
      changed: true,
      accountId: "opencode-go",
    });
    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "opencode-go", default: true },
    ]);
    expect(readFileSync(join(codexHome, "sf-opencode-go.config.toml"), "utf8"))
      .toContain('model_provider = "opencode-go"');
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "opencode-go"))).toBe(true);
    expect(loadManagedModelProviders(environment)).toEqual([
      { provider: "deepseek" },
      { provider: "opencode-go" },
    ]);
  });

  it("migrates a legacy exclusive layout without touching the base config", async () => {
    const codexHome = await configuredHome("switching");
    rmSync(join(connectHomeFor(codexHome), "providers", "deepseek", "managed.toml"));
    rmSync(join(codexHome, "sf-deepseek.config.toml"));
    configureLegacyOpenCodeGo(codexHome, "exclusive");
    const environment = testEnvironment(codexHome);

    expect(migrateLegacyOpencodeGoAccount(environment)).toEqual({
      changed: true,
      accountId: "opencode-go",
    });
    expect(parse(readFileSync(join(codexHome, "config.toml"), "utf8")))
      .toMatchObject({ model_provider: "opencode-go" });
    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "opencode-go", default: true },
    ]);
    expect(loadPrimaryModelProvider(environment)).toBe("opencode-go");
  });

  it("rejects legacy migration when the managed Profile is missing", async () => {
    const codexHome = await configuredHome("switching");
    configureLegacyOpenCodeGo(codexHome);
    rmSync(join(codexHome, "sf-opencode-go.config.toml"));
    const environment = testEnvironment(codexHome);

    expect(() => migrateLegacyOpencodeGoAccount(environment)).toThrow();
    expect(existsSync(opencodeGoAccountsFilePath(environment))).toBe(false);
  });

  it("preserves deployed main Threads while restoring opencode-go as the default account", async () => {
    const codexHome = await configuredHome("switching");
    configurePrMainOpenCodeGo(codexHome);
    writeFileSync(
      join(codexHome, "sf-agent.config.toml"),
      readFileSync(join(codexHome, "sf-opencode-go-main.config.toml"), "utf8")
        .replace('model_provider = "opencode-go-main"', "model_provider='opencode-go-main'"),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(migrateLegacyOpencodeGoAccount(environment)).toEqual({
      changed: true,
      accountId: "opencode-go",
    });
    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "opencode-go", default: true },
      { id: "main", default: false },
      { id: "lunare", default: false },
    ]);
    expect(readFileSync(join(codexHome, "sf-opencode-go.config.toml"), "utf8"))
      .toContain('model_provider = "opencode-go"');
    expect(readFileSync(join(codexHome, "sf-opencode-go-main.config.toml"), "utf8"))
      .toContain('model_provider = "opencode-go-main"');
    expect(readFileSync(join(codexHome, "sf-agent.config.toml"), "utf8"))
      .toContain('model_provider = "opencode-go"');
    expect(readOpencodeGoAccountMarker(environment, "opencode-go"))
      .toMatchObject({ provider: "opencode-go", mode: "switching" });
    expect(readOpencodeGoAccountMarker(environment, "main"))
      .toMatchObject({ provider: "opencode-go-main", mode: "switching" });
    expect(readOpencodeGoAccountMarker(environment, "lunare"))
      .toMatchObject({ provider: "opencode-go-lunare", mode: "switching" });
    expect(loadManagedModelProviders(environment)).toEqual([
      { provider: "deepseek" },
      { provider: "opencode-go" },
      { provider: "opencode-go-main" },
      { provider: "opencode-go-lunare" },
    ]);
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

  it("rejects a switching profile with a root context override", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-deepseek.config.toml"),
      providerProfile("switching", providerCatalogPath(codexHome)).replace(
        'model_provider = "deepseek"\n',
        'model_provider = "deepseek"\nmodel_context_window = 1048576\n',
      ),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(loadManagedModelProvider(environment)).toMatchObject({ provider: "deepseek" });
    expect(() => loadManagedProviderAppServer(environment))
      .toThrow("模型目录或思考等级无效");
  });

  it("rejects a switching profile without the reasoning mirror", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-deepseek.config.toml"),
      providerProfile("switching", providerCatalogPath(codexHome)).replace(
        'model_reasoning_effort = "high"\n',
        "",
      ),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(() => loadManagedProviderAppServer(environment))
      .toThrow("模型目录或思考等级无效");
  });

  it("rejects a switching profile whose reasoning mirror differs from the catalog default", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-deepseek.config.toml"),
      providerProfile("switching", providerCatalogPath(codexHome)).replace(
        'model_reasoning_effort = "high"\n',
        'model_reasoning_effort = "low"\n',
      ),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(() => loadManagedProviderAppServer(environment))
      .toThrow("模型目录或思考等级无效");
  });

  it("repairs a switching profile missing the reasoning mirror when writing defaults", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-deepseek.config.toml"),
      providerProfile("switching", providerCatalogPath(codexHome)).replace(
        'model_reasoning_effort = "high"\n',
        "",
      ),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(writeManagedModelProviderProfileDefault("deepseek", {
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      autoCompactLimit: 629_146,
    }, environment)).toMatchObject({ mode: "switching" });
    expect(parse(readFileSync(
      join(codexHome, "sf-deepseek.config.toml"),
      "utf8",
    ))).toMatchObject({
      model: "deepseek-v4-flash",
      model_reasoning_effort: "high",
    });
    expect(validateConfiguredModelProvider(environment))
      .toEqual({ provider: "deepseek", mode: "switching" });
  });

  it("writes and removes the DeepSeek subagent role configuration without the API key", async () => {
    const codexHome = await configuredHome("switching");
    const environment = testEnvironment(codexHome);
    const rolePath = managedModelProviderRoleConfigPath(environment);

    writeManagedModelProviderRoleConfig(environment, {
      provider: "deepseek",
      baseUrl: "http://127.0.0.1:39491/",
    });
    writeFileSync(
      join(codexHome, "config.toml"),
      `[agents.external]\nconfig_file = ${JSON.stringify(rolePath)}\n`,
      { mode: 0o600 },
    );

    const content = readFileSync(rolePath, "utf8");
    expect(content).toContain('model = "deepseek-v4-flash"');
    expect(content).toContain('model_provider = "deepseek"');
    expect(content).toContain('model_reasoning_effort = "high"');
    expect(content).toContain(
      'developer_instructions = "你是第三方模型单次子代理。',
    );
    expect(content).toContain("最后一条用户消息");
    expect(content).toContain("不要尝试解析 encrypted_content");
    expect(content).toContain("不等待或请求后续消息");
    expect(content).toContain('base_url = "http://127.0.0.1:39491/"');
    expect(content).toContain('env_key = "CODEX_CONNECT_DEEPSEEK_API_KEY"');
    expect(content).toContain("request_max_retries = 1");
    expect(content).toContain("stream_max_retries = 0");
    expect(content).not.toContain("model_context_window");
    expect(content).not.toContain("model_auto_compact_token_limit");
    expect(content).not.toContain("experimental_bearer_token");
    expect(content).not.toContain("sk-test-secret");
    expect(loadManagedModelProviderRole(environment)).toEqual({
      role: "external",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    });

    if (process.platform !== "win32") expect(statSync(rolePath).mode & 0o777).toBe(0o600);
    const firstRoleInode = statSync(rolePath).ino;
    writeManagedModelProviderRoleConfig(environment, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "http://127.0.0.1:39492/",
    });
    expect(statSync(rolePath).ino).not.toBe(firstRoleInode);
    expect(readFileSync(rolePath, "utf8")).toContain(
      'base_url = "http://127.0.0.1:39492/"',
    );
    expect(readFileSync(rolePath, "utf8")).toContain('model = "deepseek-v4-pro"');
    expect(readFileSync(rolePath, "utf8")).toContain('model_reasoning_effort = "low"');
    expect(() => writeManagedModelProviderRoleConfig(environment, {
      provider: "deepseek",
      baseUrl: "not-a-url",
    })).toThrow("base_url 无效");

    removeManagedModelProviderRoleConfig(environment);
    expect(existsSync(rolePath)).toBe(false);
  });

  it("writes a custom switching Provider subagent role without duplicating its API key", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-agent-role-"));
    const environment = testEnvironment(codexHome);
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "codeproxy-dev",
      model: "gpt-5.6-sol",
      name: "CodeProxy Dev",
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "custom-agent-secret",
      supportsWebsockets: true,
    }, environment);
    const rolePath = managedModelProviderRoleConfigPath(environment);

    expect(loadCustomModelProviderRoleCandidates(environment)).toContainEqual(
      expect.objectContaining({
        provider: "codeproxy-dev",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        mode: "switching",
      }),
    );
    writeThirdPartyModelProviderRoleConfig(environment, {
      provider: "codeproxy-dev",
      model: "gpt-5.6-sol",
      baseUrl: "http://127.0.0.1:39493/role/external",
    });
    writeFileSync(
      join(codexHome, "config.toml"),
      `model_provider = "openai"\n[agents.external]\nconfig_file = ${JSON.stringify(rolePath)}\n`,
      { mode: 0o600 },
    );

    const content = readFileSync(rolePath, "utf8");
    expect(content).toContain('model_provider = "codeproxy-dev"');
    expect(content).toContain('model_reasoning_effort = "medium"');
    expect(content).toContain('base_url = "http://127.0.0.1:39493/role/external"');
    expect(content).toContain('env_key = "CODEX_CONNECT_CUSTOM_');
    expect(content).toContain("request_max_retries = 1");
    expect(content).toContain("stream_max_retries = 0");
    expect(content).not.toContain("custom-agent-secret");
    expect(content).not.toContain("experimental_bearer_token");
    expect(loadManagedModelProviderRole(environment)).toBeUndefined();
    expect(loadThirdPartyModelProviderRole(environment)).toEqual({
      role: "external",
      provider: "codeproxy-dev",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      providerType: "custom",
    });
    expect(loadThirdPartyProviderCredential("codeproxy-dev", environment)).toEqual({
      environmentKey: "CODEX_CONNECT_CUSTOM_636F646570726F78792D646576_API_KEY",
      apiKey: "custom-agent-secret",
    });
  });

  it("writes a custom fixed Provider subagent role with an isolated environment key", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-fixed-agent-role-"));
    const environment = testEnvironment(codexHome);
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.6-sol"',
      'model_provider = "codeproxy-fixed"',
      'model_reasoning_effort = "medium"',
      "",
      "[model_providers.codeproxy-fixed]",
      'name = "CodeProxy Fixed"',
      'base_url = "https://fixed.example.test/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      'experimental_bearer_token = "custom-fixed-secret"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(loadCustomModelProviderRoleCandidates(environment)).toContainEqual(
      expect.objectContaining({
        provider: "codeproxy-fixed",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        mode: "exclusive",
      }),
    );
    writeThirdPartyModelProviderRoleConfig(environment, {
      provider: "codeproxy-fixed",
      baseUrl: "http://127.0.0.1:39494/role/external",
    });

    const rolePath = managedModelProviderRoleConfigPath(environment);
    writeFileSync(join(codexHome, "config.toml"), [
      readFileSync(join(codexHome, "config.toml"), "utf8").trimEnd(),
      "",
      "[agents.external]",
      `config_file = ${JSON.stringify(rolePath)}`,
      "",
    ].join("\n"), { mode: 0o600 });
    const content = readFileSync(rolePath, "utf8");
    expect(content).toContain('model_provider = "codeproxy-fixed"');
    expect(content).toContain('env_key = "CODEX_CONNECT_CUSTOM_');
    expect(content).not.toContain("custom-fixed-secret");
    expect(content).not.toContain("experimental_bearer_token");
    expect(loadThirdPartyModelProviderRole(environment)).toEqual({
      role: "external",
      provider: "codeproxy-fixed",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      providerType: "custom",
    });
    expect(loadThirdPartyProviderCredential("codeproxy-fixed", environment)).toEqual({
      environmentKey: "CODEX_CONNECT_CUSTOM_636F646570726F78792D6669786564_API_KEY",
      apiKey: "custom-fixed-secret",
    });
  });

  it("rejects an invalid custom fixed Provider subagent reasoning effort before writing", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-fixed-agent-effort-"));
    const environment = testEnvironment(codexHome);
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.6-sol"',
      'model_provider = "codeproxy-fixed"',
      'model_reasoning_effort = "invalid effort"',
      "",
      "[model_providers.codeproxy-fixed]",
      'base_url = "https://fixed.example.test/v1"',
      'wire_api = "responses"',
      'experimental_bearer_token = "custom-fixed-secret"',
      "",
    ].join("\n"), { mode: 0o600 });

    expect(() => writeThirdPartyModelProviderRoleConfig(environment, {
      provider: "codeproxy-fixed",
    })).toThrow("不具备可用的子代理配置");
    expect(existsSync(managedModelProviderRoleConfigPath(environment))).toBe(false);
  });

  it("validates both switching and exclusive managed configurations", async () => {
    const switchingHome = await configuredHome("switching");
    const exclusiveHome = await configuredHome("exclusive");

    expect(validateConfiguredModelProvider(testEnvironment(switchingHome)))
      .toEqual({ provider: "deepseek", mode: "switching" });
    expect(validateConfiguredModelProvider(testEnvironment(exclusiveHome)))
      .toEqual({ provider: "deepseek", mode: "exclusive" });
  });

  it("rejects a managed configuration whose actual model catalog is missing", async () => {
    const codexHome = await configuredHome("switching");
    rmSync(join(connectHomeFor(codexHome), "providers", "deepseek", "models.json"));

    expect(() => loadManagedProviderAppServer(testEnvironment(codexHome)))
      .toThrow("模型目录");
    expect(() => validateConfiguredModelProvider(testEnvironment(codexHome)))
      .toThrow("模型目录");
  });

  it("rejects an exclusive configuration with a root reasoning override", async () => {
    const codexHome = await configuredHome("exclusive");
    writeFileSync(
      join(codexHome, "config.toml"),
      providerProfile("exclusive", providerCatalogPath(codexHome)).replace(
        'model_provider = "deepseek"\n',
        'model_provider = "deepseek"\nmodel_reasoning_effort = "high"\n',
      ),
      { mode: 0o600 },
    );

    expect(() => validateConfiguredModelProvider(testEnvironment(codexHome)))
      .toThrow("模型目录或思考等级无效");
  });
});

function connectHomeFor(codexHome: string): string {
  return join(codexHome, ".codex-connect");
}

function providerCatalogPath(codexHome: string): string {
  return join(connectHomeFor(codexHome), "providers", "deepseek", "models.json");
}

function testEnvironment(codexHome: string): NodeJS.ProcessEnv {
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHomeFor(codexHome) };
}

async function configuredHome(mode: "switching" | "exclusive"): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "codexc-provider-runtime-"));
  secureTestDirectory(codexHome);
  const providerDirectory = join(connectHomeFor(codexHome), "providers", "deepseek");
  secureTestDirectory(providerDirectory);
  secureTestFile(
    join(providerDirectory, "managed.toml"),
    `version = 1\nprovider = "deepseek"\nmode = "${mode}"\n`,
  );
  const profilePath = mode === "exclusive" ? "config.toml" : "sf-deepseek.config.toml";
  const catalogPath = join(providerDirectory, "models.json");
  secureTestFile(
    join(codexHome, profilePath),
    providerProfile(mode, catalogPath),
  );
  secureTestFile(
    catalogPath,
    providerCatalog(),
  );
  return codexHome;
}

function providerProfile(
  mode: "switching" | "exclusive",
  catalogPath: string,
): string {
  return [
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    ...(mode === "switching" ? ['model_reasoning_effort = "high"'] : []),
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[model_providers.deepseek]",
    'name = "deepseek"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    'experimental_bearer_token = "sk-test-secret"',
    "",
  ].join("\n");
}

function configureOpenCodeGo(
  codexHome: string,
  mode: "switching" | "exclusive" = "switching",
): void {
  const providerDirectory = join(
    connectHomeFor(codexHome),
    "providers",
    "opencode-go",
  );
  secureTestDirectory(providerDirectory);
  const accountId = "opencode-go";
  const accountDirectory = join(providerDirectory, "accounts", accountId);
  secureTestDirectory(accountDirectory);
  secureTestFile(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify([{ id: accountId, default: true }], null, 2)}\n`,
  );
  secureTestFile(
    join(accountDirectory, "managed.toml"),
    `version = 1\nprovider = "opencode-go"\nmode = "${mode}"\n`,
  );
  const catalogPath = join(providerDirectory, "models.json");
  secureTestFile(
    catalogPath,
    providerCatalog(),
  );
  const provider = "opencode-go";
  secureTestFile(join(codexHome, mode === "exclusive" ? "config.toml" : "sf-opencode-go.config.toml"), [
    'model = "deepseek-v4-flash"',
    `model_provider = "${provider}"`,
    ...(mode === "switching" ? ['model_reasoning_effort = "high"'] : []),
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    `[model_providers.${provider}]`,
    `name = "${provider}"`,
    'base_url = "https://opencode.ai/zen/go/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    'experimental_bearer_token = "sk-opencode-test-secret"',
    "",
  ].join("\n"));
}

function configureLegacyOpenCodeGo(
  codexHome: string,
  mode: "switching" | "exclusive" = "switching",
): void {
  const providerDirectory = join(
    connectHomeFor(codexHome),
    "providers",
    "opencode-go",
  );
  secureTestDirectory(providerDirectory);
  secureTestFile(
    join(providerDirectory, "managed.toml"),
    `version = 1\nprovider = "opencode-go"\nmode = "${mode}"\n`,
  );
  const catalogPath = join(providerDirectory, "models.json");
  secureTestFile(
    catalogPath,
    providerCatalog(),
  );
  secureTestFile(join(codexHome, mode === "exclusive" ? "config.toml" : "sf-opencode-go.config.toml"), [
    'model = "deepseek-v4-flash"',
    'model_provider = "opencode-go"',
    ...(mode === "switching" ? ['model_reasoning_effort = "high"'] : []),
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[model_providers.opencode-go]",
    'name = "opencode-go"',
    'base_url = "https://opencode.ai/zen/go/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    'experimental_bearer_token = "sk-opencode-test-secret"',
    "",
  ].join("\n"));
}

function configurePrMainOpenCodeGo(codexHome: string): void {
  configureOpenCodeGo(codexHome);
  const providerDirectory = join(connectHomeFor(codexHome), "providers", "opencode-go");
  const accountsDirectory = join(providerDirectory, "accounts");
  renameSync(join(accountsDirectory, "opencode-go"), join(accountsDirectory, "main"));
  writeFileSync(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify([
      { id: "main", default: true },
      { id: "lunare", default: false },
    ], null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(accountsDirectory, "main", "managed.toml"),
    'version = 1\nprovider = "opencode-go-main"\nmode = "switching"\n',
    { mode: 0o600 },
  );
  const profile = readFileSync(join(codexHome, "sf-opencode-go.config.toml"), "utf8")
    .replace('model_provider = "opencode-go"', 'model_provider = "opencode-go-main"')
    .replace("[model_providers.opencode-go]", "[model_providers.opencode-go-main]")
    .replace('name = "opencode-go"', 'name = "opencode-go-main"');
  rmSync(join(codexHome, "sf-opencode-go.config.toml"));
  writeFileSync(join(codexHome, "sf-opencode-go-main.config.toml"), profile, { mode: 0o600 });
  mkdirSync(join(accountsDirectory, "lunare"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(accountsDirectory, "lunare", "managed.toml"),
    'version = 1\nprovider = "opencode-go-lunare"\nmode = "switching"\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(codexHome, "sf-opencode-go-lunare.config.toml"),
    profile
      .replace('model_provider = "opencode-go-main"', 'model_provider = "opencode-go-lunare"')
      .replace("[model_providers.opencode-go-main]", "[model_providers.opencode-go-lunare]")
      .replace('name = "opencode-go-main"', 'name = "opencode-go-lunare"'),
    { mode: 0o600 },
  );
}

function providerCatalog(): string {
  return `${JSON.stringify({
    models: [
      {
        slug: "deepseek-v4-flash",
        display_name: "DeepSeek V4 Flash",
        context_window: 1_048_576,
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "high", description: "High" },
          { effort: "max", description: "Max" },
        ],
        auto_compact_token_limit: 629_146,
      },
      {
        slug: "deepseek-v4-pro",
        display_name: "DeepSeek V4 Pro",
        context_window: 900_000,
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "high", description: "High" },
        ],
        auto_compact_token_limit: 540_000,
      },
    ],
  })}\n`;
}
