import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import {
  customOfficialModelCatalogPath,
  customPrimaryProviderProfilePath,
  customSwitchingProviderRegistryPath,
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomSwitchingModelProviders,
  loadCustomSwitchingProviderIds,
  loadPrimaryModelProvider,
  providerAppServerSocketPath,
  removeCustomPrimaryProviderSwitchingProfile,
  withOfficialModelCatalog,
  writeCustomOfficialModelCatalog,
  writeCustomPrimaryProviderSwitchingProfile,
} from "../runtime/model-provider-runtime.mjs";
import { testEnvironment } from "./model-provider-runtime-test-fixture.js";
import { secureTestDirectory } from "./support/windows-fixtures.js";

describe("custom model provider runtime", () => {
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

  it("exports the bundled official catalog for custom Provider App Servers", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-catalog-export-"));
    await secureTestDirectory(codexHome);
    const fakeCodex = join(codexHome, "fake-codex.mjs");
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args.join(' ') !== 'debug models --bundled') process.exit(2);",
      "process.stdout.write(JSON.stringify({",
      "  models: [{ slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra' }],",
      "}));",
    ].join("\n"), { mode: 0o700 });
    chmodSync(fakeCodex, 0o700);
    const environment = { ...process.env, ...testEnvironment(codexHome) };

    const catalogPath = writeCustomOfficialModelCatalog(environment, fakeCodex);

    expect(catalogPath).toBe(customOfficialModelCatalogPath(environment));
    expect(JSON.parse(readFileSync(catalogPath, "utf8"))).toEqual({
      models: [{ slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra" }],
    });
    if (process.platform !== "win32") {
      expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
    }
    expect(withOfficialModelCatalog(["-c", 'model_provider="thirdparty"'], catalogPath))
      .toEqual([
        "-c",
        'model_provider="thirdparty"',
        "-c",
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
      ]);
    expect(withOfficialModelCatalog([
      "-c",
      'model_catalog_json="/old/models.json"',
      "-c",
      'model_provider="thirdparty"',
    ], catalogPath)).toEqual([
      "-c",
      'model_provider="thirdparty"',
      "-c",
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
    ]);

    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "process.stdout.write('{}');",
    ].join("\n"), { mode: 0o700 });
    expect(() => writeCustomOfficialModelCatalog(environment, fakeCodex))
      .toThrow("Codex 官方模型目录缺少模型");
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

});
