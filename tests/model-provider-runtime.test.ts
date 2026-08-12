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
  loadManagedProviderAppServer,
  loadOpenAiBaseUrl,
  loadPrimaryModelProvider,
  managedModelProviderRoleConfigPath,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
  removeManagedModelProviderRoleConfig,
  validateConfiguredModelProvider,
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
    expect(descriptor.managedProvider?.provider).toBe("deepseek");
    expect(descriptor.socketPaths).toEqual([
      "/private/codexc/runtime/codex.sock",
      "/private/codexc/runtime/codex-deepseek.sock",
    ]);
    expect(descriptor.topology).toEqual({
      primaryProvider: "openai",
      managedProvider: "deepseek",
      socketPaths: descriptor.socketPaths,
    });
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
    expect(managed.arguments).toContain("model_auto_compact_token_limit=629146");
    expect(managed.arguments).toContain(
      'model_auto_compact_token_limit_scope="total"',
    );

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

  it("rejects a switching profile that cannot launch the managed App Server", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "deepseek.config.toml"),
      providerProfile(codexHome).replace('model_reasoning_effort = "high"\n', ""),
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
      baseUrl: "http://127.0.0.1:39491/",
    });

    const content = readFileSync(rolePath, "utf8");
    expect(content).toContain('model = "deepseek-v4-flash"');
    expect(content).toContain('model_provider = "deepseek"');
    expect(content).toContain(
      'developer_instructions = "你是 DeepSeek 单次子代理。',
    );
    expect(content).toContain("最后一条用户消息");
    expect(content).toContain("不要尝试解析 encrypted_content");
    expect(content).toContain("不等待或请求后续消息");
    expect(content).toContain('base_url = "http://127.0.0.1:39491/"');
    expect(content).toContain('env_key = "CODEX_CONNECT_DEEPSEEK_API_KEY"');
    expect(content).toContain("model_auto_compact_token_limit = 629146");
    expect(content).not.toContain("experimental_bearer_token");
    expect(content).not.toContain("sk-test-secret");

    expect(statSync(rolePath).mode & 0o777).toBe(0o600);
    const firstRoleInode = statSync(rolePath).ino;
    writeManagedModelProviderRoleConfig(environment, {
      baseUrl: "http://127.0.0.1:39492/",
    });
    expect(statSync(rolePath).ino).not.toBe(firstRoleInode);
    expect(readFileSync(rolePath, "utf8")).toContain(
      'base_url = "http://127.0.0.1:39492/"',
    );
    expect(() => writeManagedModelProviderRoleConfig(environment, {
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
    rmSync(join(codexHome, "deepseek.models.json"));

    expect(() => loadManagedProviderAppServer({ CODEX_HOME: codexHome }))
      .toThrow("模型目录");
    expect(() => validateConfiguredModelProvider({ CODEX_HOME: codexHome }))
      .toThrow("模型目录");
  });

  it("rejects an exclusive configuration that cannot launch the primary App Server", async () => {
    const codexHome = await configuredHome("exclusive");
    writeFileSync(
      join(codexHome, "config.toml"),
      providerProfile(codexHome).replace('model_reasoning_effort = "high"\n', ""),
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
    join(codexHome, "codex-connect-deepseek.config.toml"),
    `version = 1\nprovider = "deepseek"\nmode = "${mode}"\n`,
    { mode: 0o600 },
  );
  const profilePath = mode === "exclusive" ? "config.toml" : "deepseek.config.toml";
  writeFileSync(join(codexHome, profilePath), providerProfile(codexHome), { mode: 0o600 });
  writeFileSync(
    join(codexHome, "deepseek.models.json"),
    '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
    { mode: 0o600 },
  );
  return codexHome;
}

function providerProfile(codexHome: string): string {
  return [
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    'model_reasoning_effort = "high"',
    `model_catalog_json = ${JSON.stringify(join(codexHome, "deepseek.models.json"))}`,
    "model_auto_compact_token_limit = 629146",
    'model_auto_compact_token_limit_scope = "total"',
    "[model_providers.deepseek]",
    'name = "deepseek"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    'experimental_bearer_token = "sk-test-secret"',
    "",
  ].join("\n");
}
