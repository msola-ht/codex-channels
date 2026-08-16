import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  resolveAppServerRuntime,
  resolvePrimaryAppServerSocketPath,
} from "../runtime/app-server-runtime.mjs";
import {
  loadManagedModelProvider,
  loadManagedModelProviders,
  loadManagedProviderAppServer,
  loadManagedProviderAppServers,
  loadOpenAiBaseUrl,
  loadPrimaryModelProvider,
  managedModelProviderRoleConfigPath,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
  removeManagedModelProviderRoleConfig,
  validateConfiguredModelProvider,
  validateConfiguredModelProviders,
  withProviderBaseUrl,
  withOpenAiBaseUrl,
  writeManagedModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";

describe("model provider runtime topology", () => {
  it("resolves the primary socket from one shared runtime descriptor", () => {
    expect(resolvePrimaryAppServerSocketPath(
      { codex: { socket_path: "runtime/custom.sock" } },
      "/private/codexc",
    )).toBe("/private/codexc/runtime/custom.sock");
  });

  it("describes the complete switching topology from one shared source", async () => {
    const codexHome = await configuredHome("switching");
    const descriptor = resolveAppServerRuntime(
      { codex: { socket_path: "runtime/codex.sock" } },
      "/private/codexc",
      { CODEX_HOME: codexHome },
    );

    expect(descriptor.primaryProvider).toBe("openai");
    expect(descriptor.managedProviders[0]?.provider).toBe("deepseek");
    expect(descriptor.socketPaths).toEqual([
      "/private/codexc/runtime/codex.sock",
      "/private/codexc/runtime/codex-deepseek.sock",
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
    const environment = { CODEX_HOME: codexHome };

    expect(loadManagedModelProviders(environment)).toEqual([
      { provider: "deepseek" },
      { provider: "opencode-go" },
    ]);
    expect(loadManagedProviderAppServers(environment).map((provider) => ({
      provider: provider.provider,
      environmentKeys: Object.keys(provider.childEnvironment),
    }))).toEqual([{
      provider: "deepseek",
      environmentKeys: ["CODEX_CONNECT_DEEPSEEK_API_KEY"],
    }, {
      provider: "opencode-go",
      environmentKeys: ["CODEX_CONNECT_OPENCODE_GO_API_KEY"],
    }]);
    expect(validateConfiguredModelProviders(environment)).toEqual([
      { provider: "deepseek", mode: "switching" },
      { provider: "opencode-go", mode: "switching" },
    ]);

    writeManagedModelProviderRoleConfig(environment, { provider: "deepseek" });
    expect(readFileSync(managedModelProviderRoleConfigPath(environment), "utf8"))
      .toContain('model_provider = "deepseek"');
  });

  it("uses OpenAI as primary and exposes DeepSeek as an auxiliary switching server", async () => {
    const codexHome = await configuredHome("switching");
    const environment = { CODEX_HOME: codexHome };

    expect(loadPrimaryModelProvider(environment)).toBe("openai");
    expect(loadManagedModelProvider(environment)).toMatchObject({ provider: "deepseek" });
  });

  it("uses the native DeepSeek configuration as the only primary server in exclusive mode", async () => {
    const codexHome = await configuredHome("exclusive");
    const environment = { CODEX_HOME: codexHome };

    expect(loadPrimaryModelProvider(environment)).toBe("deepseek");
    expect(loadManagedModelProvider(environment)).toBeUndefined();
  });

  it("uses OpenCode Go as the primary server in exclusive mode", async () => {
    const codexHome = await configuredHome("switching");
    rmSync(join(codexHome, "sf-deepseek.managed.toml"));
    rmSync(join(codexHome, "sf-deepseek.config.toml"));
    configureOpenCodeGo(codexHome, "exclusive");
    const environment = { CODEX_HOME: codexHome };

    expect(loadPrimaryModelProvider(environment)).toBe("opencode-go");
    expect(loadManagedModelProvider(environment)).toBeUndefined();
    expect(validateConfiguredModelProvider(environment))
      .toEqual({ provider: "opencode-go", mode: "exclusive" });
  });

  it("rejects more than one exclusive third-party Provider", async () => {
    const codexHome = await configuredHome("exclusive");
    configureOpenCodeGo(codexHome, "exclusive");
    const environment = { CODEX_HOME: codexHome };

    expect(() => loadPrimaryModelProvider(environment))
      .toThrow("只能有一个受管第三方 Provider 使用固定模式");
    expect(() => validateConfiguredModelProviders(environment))
      .toThrow("只能有一个受管第三方 Provider 使用固定模式");
  });

  it("derives a private sibling socket without changing the configured primary socket", () => {
    expect(providerAppServerSocketPath(
      "/private/runtime/codex-app-server.sock",
      "deepseek",
    )).toBe("/private/runtime/codex-app-server-deepseek.sock");
  });

  it("derives a private metrics socket beside the provider App Server socket", () => {
    expect(providerMetricsSocketPath(
      "/private/runtime/codex-app-server.sock",
      "deepseek",
    )).toBe("/private/runtime/codex-app-server-deepseek-metrics.sock");
  });

  it("preserves a configured OpenAI base URL behind the local metrics proxy", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "config.toml"),
      'openai_base_url = "https://regional.example.test/codex"\n',
      { mode: 0o600 },
    );

    expect(loadOpenAiBaseUrl({ CODEX_HOME: codexHome }))
      .toBe("https://regional.example.test/codex");
    expect(withOpenAiBaseUrl([], "http://127.0.0.1:45678"))
      .toEqual(["-c", 'openai_base_url="http://127.0.0.1:45678"']);
  });

  it("does not invent an OpenAI base URL when config.toml does not declare one", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n', {
      mode: 0o600,
    });

    expect(loadOpenAiBaseUrl({ CODEX_HOME: codexHome })).toBeUndefined();
  });

  it("replaces the managed provider base URL with a local proxy address", async () => {
    const codexHome = await configuredHome("switching");
    const environment = { CODEX_HOME: codexHome };
    const managed = loadManagedProviderAppServer(environment);
    if (!managed) {
      throw new Error("测试环境缺少 DeepSeek 托管配置");
    }
    expect(managed.arguments).toContain(
      "model_providers.deepseek.base_url=\"https://api.deepseek.com/\"",
    );
    expect(managed.arguments.some((argument) =>
      argument.startsWith("model_reasoning_effort=")
    )).toBe(false);
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
    expect(overridden.at(-2)).toBe("-c");
    expect(overridden.some((value, index) =>
      value === "-c" && overridden[index + 1] === "-c"
    )).toBe(false);
  });

  it("rejects a switching profile with a root context override", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-deepseek.config.toml"),
      providerProfile(codexHome).replace(
        'model_provider = "deepseek"\n',
        'model_provider = "deepseek"\nmodel_context_window = 1048576\n',
      ),
      { mode: 0o600 },
    );
    const environment = { CODEX_HOME: codexHome };

    expect(loadManagedModelProvider(environment)).toMatchObject({ provider: "deepseek" });
    expect(() => loadManagedProviderAppServer(environment))
      .toThrow("模型目录或思考等级无效");
  });

  it("writes and removes the DeepSeek subagent role configuration without the API key", async () => {
    const codexHome = await configuredHome("switching");
    const environment = { CODEX_HOME: codexHome };
    const rolePath = managedModelProviderRoleConfigPath(environment);

    writeManagedModelProviderRoleConfig(environment, {
      provider: "deepseek",
      baseUrl: "http://127.0.0.1:39491/",
    });

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
    expect(content).not.toContain("model_context_window");
    expect(content).not.toContain("model_auto_compact_token_limit");
    expect(content).not.toContain("experimental_bearer_token");
    expect(content).not.toContain("sk-test-secret");

    expect(statSync(rolePath).mode & 0o777).toBe(0o600);
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

  it("validates both switching and exclusive managed configurations", async () => {
    const switchingHome = await configuredHome("switching");
    const exclusiveHome = await configuredHome("exclusive");

    expect(validateConfiguredModelProvider({ CODEX_HOME: switchingHome }))
      .toEqual({ provider: "deepseek", mode: "switching" });
    expect(validateConfiguredModelProvider({ CODEX_HOME: exclusiveHome }))
      .toEqual({ provider: "deepseek", mode: "exclusive" });
  });

  it("rejects a managed configuration whose actual model catalog is missing", async () => {
    const codexHome = await configuredHome("switching");
    rmSync(join(codexHome, "sf-deepseek.models.json"));

    expect(() => loadManagedProviderAppServer({ CODEX_HOME: codexHome }))
      .toThrow("模型目录");
    expect(() => validateConfiguredModelProvider({ CODEX_HOME: codexHome }))
      .toThrow("模型目录");
  });

  it("rejects an exclusive configuration with a root reasoning override", async () => {
    const codexHome = await configuredHome("exclusive");
    writeFileSync(
      join(codexHome, "config.toml"),
      providerProfile(codexHome).replace(
        'model_provider = "deepseek"\n',
        'model_provider = "deepseek"\nmodel_reasoning_effort = "high"\n',
      ),
      { mode: 0o600 },
    );

    expect(() => validateConfiguredModelProvider({ CODEX_HOME: codexHome }))
      .toThrow("模型目录或思考等级无效");
  });
});

async function configuredHome(mode: "switching" | "exclusive"): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "codexc-provider-runtime-"));
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(codexHome, "sf-deepseek.managed.toml"),
    `version = 1\nprovider = "deepseek"\nmode = "${mode}"\n`,
    { mode: 0o600 },
  );
  const profilePath = mode === "exclusive" ? "config.toml" : "sf-deepseek.config.toml";
  writeFileSync(join(codexHome, profilePath), providerProfile(codexHome), { mode: 0o600 });
  writeFileSync(
    join(codexHome, "sf-deepseek.models.json"),
    providerCatalog(),
    { mode: 0o600 },
  );
  return codexHome;
}

function providerProfile(codexHome: string): string {
  return [
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    `model_catalog_json = ${JSON.stringify(join(codexHome, "sf-deepseek.models.json"))}`,
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
  writeFileSync(
    join(codexHome, "sf-opencode-go.managed.toml"),
    `version = 1\nprovider = "opencode-go"\nmode = "${mode}"\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(codexHome, "sf-opencode-go.models.json"),
    providerCatalog(),
    { mode: 0o600 },
  );
  writeFileSync(join(codexHome, mode === "exclusive" ? "config.toml" : "sf-opencode-go.config.toml"), [
    'model = "deepseek-v4-flash"',
    'model_provider = "opencode-go"',
    `model_catalog_json = ${JSON.stringify(join(codexHome, "sf-opencode-go.models.json"))}`,
    "[model_providers.opencode-go]",
    'name = "opencode-go"',
    'base_url = "https://opencode.ai/zen/go/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    'experimental_bearer_token = "sk-opencode-test-secret"',
    "",
  ].join("\n"), { mode: 0o600 });
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
