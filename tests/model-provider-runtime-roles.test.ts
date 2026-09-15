import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadCustomModelProviderRoleCandidates,
  loadManagedModelProviderRole,
  loadThirdPartyModelProviderRole,
  loadThirdPartyProviderCredential,
  managedModelProviderRoleConfigPath,
  removeManagedModelProviderRoleConfig,
  writeCustomPrimaryProviderSwitchingProfile,
  writeManagedModelProviderRoleConfig,
  writeThirdPartyModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import {
  configuredHome,
  testEnvironment,
} from "./model-provider-runtime-test-fixture.js";

describe("model provider runtime roles", () => {
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

});
