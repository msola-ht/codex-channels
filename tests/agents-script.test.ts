import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import {
  AgentsManagementError,
  applyThirdPartyAgentChange,
  agentsStatus,
  assertThirdPartyRoleDoesNotUseProvider,
  configureThirdPartyRole,
  disableThirdPartyRole,
  previewThirdPartyAgentChange,
} from "../scripts/agents.mjs";
import { runThirdPartyAgentSetup } from "../scripts/agents-setup.mjs";
import type {
  CodexUserConfigValue,
} from "../scripts/codex-user-config.mjs";
import type {
  CodexUserConfigWriter,
  ThirdPartyAgentProvider,
} from "../scripts/agents.mjs";
import {
  deepseekProviderDefinition,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import type {
  ManagedModelProviderId,
  ModelProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import {
  opencodeGoApiKeyEnvironmentKey,
  opencodeGoProviderId,
} from "../runtime/opencode-go-accounts.mjs";
import {
  createManagedProviderMarker,
  createManagedProviderProfile,
} from "../runtime/model-provider-profile.mjs";
import { writeCustomPrimaryProviderSwitchingProfile } from "../runtime/model-provider-runtime.mjs";
import {
  securePrivateDirectorySync,
  securePrivateFileSync,
  writePrivateFileAtomicSync,
} from "../runtime/private-file.mjs";

describe("codexc agents script", () => {
  it("previews a shared role change without prompts or configuration writes", () => {
    const preview = previewThirdPartyAgentChange(
      { action: "configure", provider: "deepseek", model: "deepseek-v4-pro" },
      {
        environment: {},
        loadProviders: managementProviders,
        loadStatus: unconfiguredManagementStatus,
        validateRoleAvailability: false,
      },
    );

    expect(preview).toEqual({
      operation: "configure",
      current: { configured: false, provider: null, model: null },
      selection: {
        provider: "deepseek",
        providerDisplayName: "DeepSeek",
        model: "deepseek-v4-pro",
        modelDisplayName: "DeepSeek V4 Pro",
      },
      willChange: true,
      activation: "restart-all",
    });
  });

  it("returns stable field errors from the shared role management interface", () => {
    try {
      previewThirdPartyAgentChange(
        { action: "configure", provider: "deepseek", model: "unknown-model" },
        {
          environment: {},
          loadProviders: managementProviders,
          loadStatus: unconfiguredManagementStatus,
          validateRoleAvailability: false,
        },
      );
      throw new Error("expected preview to reject the unsupported model");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentsManagementError);
      expect(error).toMatchObject({ code: "model-not-supported", field: "model" });
    }
  });

  it("applies shared role changes and skips an unchanged disable operation", async () => {
    const configureRole = vi.fn(async (provider: string, model?: string) => ({
      role: "external" as const,
      provider,
      model: model ?? "deepseek-v4-flash-vision-exp",
    }));
    const configured = await applyThirdPartyAgentChange(
      { action: "configure", provider: "deepseek" },
      {
        environment: {},
        loadProviders: managementProviders,
        loadStatus: unconfiguredManagementStatus,
        configureRole,
      },
    );
    expect(configured).toEqual({
      action: "configured",
      activation: "restart-all",
      previous: { configured: false, provider: null, model: null },
      selection: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
    });
    expect(configureRole).toHaveBeenCalledWith(
      "deepseek",
      "deepseek-v4-flash-vision-exp",
      {},
    );

    const disableRole = vi.fn(async () => true);
    const disabled = await applyThirdPartyAgentChange(
      { action: "disable" },
      {
        environment: {},
        loadProviders: managementProviders,
        loadStatus: unconfiguredManagementStatus,
        disableRole,
      },
    );
    expect(disabled).toEqual({
      action: "unchanged",
      activation: "none",
      previous: { configured: false, provider: null, model: null },
    });
    expect(disableRole).not.toHaveBeenCalled();
  });

  it("configures the shared role through the Setup menu", async () => {
    const configureRole = vi.fn(async () => ({
      role: "external" as const,
      provider: "deepseek" as const,
      model: "deepseek-v4-pro",
    }));
    const output: string[] = [];
    const prompts = {
      select: vi.fn()
        .mockResolvedValueOnce("configure")
        .mockResolvedValueOnce("deepseek")
        .mockResolvedValueOnce("deepseek-v4-pro"),
      confirm: vi.fn(),
      isCancel: () => false,
    };

    const result = await runThirdPartyAgentSetup({
      environment: {},
      output: { write: (value: string) => output.push(value) > 0 },
      prompts,
      loadProviders: () => [{
        provider: "deepseek",
        displayName: "DeepSeek",
        model: "deepseek-v4-flash-vision-exp",
        reasoningEffort: "high",
        mode: "switching",
        models: [{
          model: "deepseek-v4-flash-vision-exp",
          displayName: "DeepSeek V4 Flash Vision",
          contextWindow: 1_048_576,
          reasoningEffort: "high",
          reasoningEfforts: [{ effort: "high", description: "High" }],
        }, {
          model: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          contextWindow: 1_048_576,
          reasoningEffort: "high",
          reasoningEfforts: [{ effort: "high", description: "High" }],
        }],
      }],
      loadStatus: () => ({
        configPath: "/private/config.toml",
        roleConfigPath: "/private/sf-agent.config.toml",
        multiAgentV2Enabled: false,
        externalRoleConfigured: false,
        legacyDsRoleConfigured: false,
      }),
      configureRole,
    });

    expect(result).toEqual({
      action: "configured",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      activation: "restart-all",
      activationResult: {
        status: "restart",
        target: "all",
        commands: ["codexc service restart all"],
      },
    });
    expect(configureRole).toHaveBeenCalledWith("deepseek", "deepseek-v4-pro", {});
    expect(output.join("")).toContain("已配置共享第三方子代理：deepseek / deepseek-v4-pro");
    expect(output.join("")).toContain("codexc service restart all");
  });

  it("confirms before disabling the shared role through the Setup menu", async () => {
    const disableRole = vi.fn(async () => true);
    const output: string[] = [];
    const prompts = {
      select: vi.fn().mockResolvedValueOnce("disable"),
      confirm: vi.fn().mockResolvedValueOnce(true),
      isCancel: () => false,
    };

    const result = await runThirdPartyAgentSetup({
      environment: {},
      output: { write: (value: string) => output.push(value) > 0 },
      prompts,
      loadProviders: () => [],
      loadStatus: () => ({
        configPath: "/private/config.toml",
        roleConfigPath: "/private/sf-agent.config.toml",
        multiAgentV2Enabled: true,
        externalRoleConfigured: true,
        legacyDsRoleConfigured: false,
        provider: "deepseek",
        model: "deepseek-v4-pro",
      }),
      disableRole,
    });

    expect(result).toEqual({
      action: "disabled",
      activation: "restart-all",
      activationResult: {
        status: "restart",
        target: "all",
        commands: ["codexc service restart all"],
      },
    });
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(disableRole).toHaveBeenCalledWith({});
    expect(output.join("")).toContain("已移除共享第三方子代理");
  });

  it.each([
    [deepseekProviderDefinition.id, deepseekProviderDefinition],
    [opencodeGoProviderId("main"), opencodeGoMainDefinition()],
  ] as const)("binds the shared role to configured provider %s", async (provider, definition) => {
    const fixture = createFixture();
    try {
      writeProviderFixture(fixture, definition, "switching");

      const selected = await configureThirdPartyRole(
        provider as ManagedModelProviderId,
        undefined,
        fixture.environment,
        { updateConfig: applyConfigUpdate },
      );

      expect(selected).toEqual({
        role: "external",
        provider,
        model: definition.defaultModel,
      });
      const config = record(parse(readFileSync(fixture.configPath, "utf8")));
      expect(config).toMatchObject({
        features: { multi_agent_v2: true },
        agents: {
          external: {
            description: expect.stringContaining("第三方模型单次子代理"),
            config_file: fixture.rolePath,
            nickname_candidates: [definition.displayName],
          },
        },
      });
      const role = parse(readFileSync(fixture.rolePath, "utf8"));
      expect(role).toMatchObject({
        model: definition.defaultModel,
        model_provider: provider,
        model_providers: {
          [provider]: {
            base_url: definition.baseUrl,
            wire_api: "responses",
          },
        },
      });
      expect(readFileSync(fixture.rolePath, "utf8")).not.toContain("sk-test-secret");
      expect(agentsStatus(fixture.environment)).toMatchObject({
        multiAgentV2Enabled: true,
        externalRoleConfigured: true,
        provider,
        model: definition.defaultModel,
      });
    } finally {
      fixture.remove();
    }
  });

  it("switches the same role between providers and accepts an explicit model", async () => {
    const fixture = createFixture();
    try {
      writeProviderFixture(fixture, deepseekProviderDefinition, "switching");
      writeProviderFixture(fixture, opencodeGoMainDefinition(), "switching");
      await configureThirdPartyRole("deepseek", undefined, fixture.environment, {
        updateConfig: applyConfigUpdate,
      });
      await configureThirdPartyRole("ocg-main", "deepseek-v4-pro", fixture.environment, {
        updateConfig: applyConfigUpdate,
      });

      expect(agentsStatus(fixture.environment)).toMatchObject({
        provider: "ocg-main",
        model: "deepseek-v4-pro",
      });
      expect(parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
        agents: { external: { nickname_candidates: ["ocg-user@example.com"] } },
      });
    } finally {
      fixture.remove();
    }
  });

  it("binds the shared role to a configured custom switching Provider", async () => {
    const fixture = createFixture();
    try {
      writeFileSync(fixture.configPath, 'model_provider = "openai"\n', { mode: 0o600 });
      writeCustomPrimaryProviderSwitchingProfile({
        provider: "codeproxy-dev",
        model: "gpt-5.6-sol",
        name: "CodeProxy Dev",
        baseUrl: "https://proxy.example.test/v1",
        apiKey: "custom-agent-secret",
      }, fixture.environment);

      const selected = await configureThirdPartyRole(
        "codeproxy-dev",
        "gpt-5.6-sol",
        fixture.environment,
        { updateConfig: applyConfigUpdate },
      );

      expect(selected).toEqual({
        role: "external",
        provider: "codeproxy-dev",
        model: "gpt-5.6-sol",
      });
      expect(agentsStatus(fixture.environment)).toMatchObject({
        externalRoleConfigured: true,
        provider: "codeproxy-dev",
        model: "gpt-5.6-sol",
      });
      const roleContent = readFileSync(fixture.rolePath, "utf8");
      expect(roleContent).not.toContain("custom-agent-secret");
      expect(parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
        agents: { external: { nickname_candidates: ["CodeProxy Dev"] } },
      });
      expect(() => assertThirdPartyRoleDoesNotUseProvider(
        "codeproxy-dev",
        fixture.environment,
      )).toThrow("正由 agents.external 使用");
      expect(() => assertThirdPartyRoleDoesNotUseProvider(
        "another-provider",
        fixture.environment,
      )).not.toThrow();
    } finally {
      fixture.remove();
    }
  });

  it("replaces the previously managed ds role without touching user roles", async () => {
    const fixture = createFixture();
    const legacyPath = join(fixture.home, "codex-connect-ds-subagent.config.toml");
    try {
      writeProviderFixture(fixture, deepseekProviderDefinition, "switching");
      writeFileSync(legacyPath, 'model_provider = "deepseek"\n', { mode: 0o600 });
      writeFileSync(fixture.configPath, [
        "[features]",
        "multi_agent_v2 = true",
        "[agents.ds]",
        'description = "Old managed role"',
        `config_file = ${JSON.stringify(legacyPath)}`,
        "[agents.reviewer]",
        'description = "User role"',
        "",
      ].join("\n"), { mode: 0o600 });

      await configureThirdPartyRole("deepseek", undefined, fixture.environment, {
        updateConfig: applyConfigUpdate,
      });

      const agents = record(parse(readFileSync(fixture.configPath, "utf8")).agents);
      expect(agents.ds).toBeUndefined();
      expect(agents.external).toBeDefined();
      expect(agents.reviewer).toEqual({ description: "User role" });
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      fixture.remove();
    }
  });

  it("reports and disables the legacy managed ds role", async () => {
    const fixture = createFixture();
    const legacyPath = join(fixture.home, "codex-connect-ds-subagent.config.toml");
    try {
      writeFileSync(legacyPath, 'model_provider = "deepseek"\n', { mode: 0o600 });
      writeFileSync(fixture.configPath, [
        "[features]",
        "multi_agent_v2 = true",
        "[agents.ds]",
        'description = "Old managed role"',
        `config_file = ${JSON.stringify(legacyPath)}`,
        "",
      ].join("\n"), { mode: 0o600 });

      expect(agentsStatus(fixture.environment)).toMatchObject({
        multiAgentV2Enabled: true,
        externalRoleConfigured: false,
        legacyDsRoleConfigured: true,
      });

      await disableThirdPartyRole(fixture.environment, { updateConfig: applyConfigUpdate });

      expect(parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
        features: { multi_agent_v2: false },
        agents: {},
      });
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      fixture.remove();
    }
  });

  it("reports when there is no managed role to disable", async () => {
    const fixture = createFixture();
    try {
      writeFileSync(fixture.configPath, [
        "[features]",
        "multi_agent_v2 = true",
        "",
      ].join("\n"), { mode: 0o600 });

      const removed = await disableThirdPartyRole(fixture.environment, {
        updateConfig: applyConfigUpdate,
      });

      expect(removed).toBe(false);
      expect(parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
        features: { multi_agent_v2: true },
      });
    } finally {
      fixture.remove();
    }
  });

  it("supports a provider configured as the fixed primary", async () => {
    const fixture = createFixture();
    try {
      writeProviderFixture(fixture, opencodeGoMainDefinition(), "exclusive");

      await configureThirdPartyRole("ocg-main", undefined, fixture.environment, {
        updateConfig: applyConfigUpdate,
      });

      expect(agentsStatus(fixture.environment)).toMatchObject({
        provider: "ocg-main",
        model: "deepseek-v4-flash",
      });
    } finally {
      fixture.remove();
    }
  });

  it("rejects an unconfigured provider and an unavailable model", async () => {
    const fixture = createFixture();
    try {
      await expect(configureThirdPartyRole(
        "deepseek",
        undefined,
        fixture.environment,
        { updateConfig: applyConfigUpdate },
      )).rejects.toThrow("尚未配置");
      writeProviderFixture(fixture, deepseekProviderDefinition, "switching");
      await expect(configureThirdPartyRole(
        "deepseek",
        "unknown-model",
        fixture.environment,
        { updateConfig: applyConfigUpdate },
      )).rejects.toThrow("不支持模型");
      writeFileSync(
        join(
          fixture.providerDirectory(deepseekProviderDefinition),
          deepseekProviderDefinition.catalogFileName,
        ),
        '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
        { mode: 0o600 },
      );
      await expect(configureThirdPartyRole(
        "deepseek",
        "deepseek-v4-pro",
        fixture.environment,
        { updateConfig: applyConfigUpdate },
      )).rejects.toThrow("模型目录无法安全读取");
    } finally {
      fixture.remove();
    }
  });

  it("does not overwrite a user-managed agents.external role", async () => {
    const fixture = createFixture();
    try {
      writeProviderFixture(fixture, deepseekProviderDefinition, "switching");
      writeFileSync(fixture.configPath, [
        "[features]",
        "multi_agent_v2 = true",
        "[agents.external]",
        'description = "User role"',
        'config_file = "/opt/user/external.toml"',
        "",
      ].join("\n"), { mode: 0o600 });

      expect(agentsStatus(fixture.environment)).toMatchObject({
        externalRoleConfigured: false,
        provider: undefined,
        model: undefined,
      });

      await expect(configureThirdPartyRole(
        "deepseek",
        undefined,
        fixture.environment,
        { updateConfig: applyConfigUpdate },
      )).rejects.toThrow("agents.external 已由用户配置");
    } finally {
      fixture.remove();
    }
  });

  it("disables only the managed role and preserves multi_agent_v2 when other roles exist", async () => {
    const fixture = createFixture();
    try {
      writeProviderFixture(fixture, deepseekProviderDefinition, "switching");
      await configureThirdPartyRole("deepseek", undefined, fixture.environment, {
        updateConfig: applyConfigUpdate,
      });
      const config = record(parse(readFileSync(fixture.configPath, "utf8")));
      const agents = record(config.agents);
      agents.reviewer = { description: "Reviewer" };
      config.agents = agents;
      writeFileSync(fixture.configPath, stringify(config), { mode: 0o600 });

      await disableThirdPartyRole(fixture.environment, { updateConfig: applyConfigUpdate });

      expect(parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
        features: { multi_agent_v2: true },
        agents: { reviewer: { description: "Reviewer" } },
      });
      expect(existsSync(fixture.rolePath)).toBe(false);
    } finally {
      fixture.remove();
    }
  });

  it("serializes concurrent role and config transactions", async () => {
    const fixture = createFixture();
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    let updateCalls = 0;
    const serializedUpdate: CodexUserConfigWriter = async (environment, createEdits) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        markFirstEntered();
        await firstMayFinish;
      }
      await applyConfigUpdate(environment, createEdits);
    };
    try {
      writeProviderFixture(fixture, deepseekProviderDefinition, "switching");
      writeProviderFixture(fixture, opencodeGoMainDefinition(), "switching");

      const first = configureThirdPartyRole("deepseek", undefined, fixture.environment, {
        updateConfig: serializedUpdate,
      });
      await firstEntered;
      const second = configureThirdPartyRole("ocg-main", undefined, fixture.environment, {
        updateConfig: serializedUpdate,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(updateCalls).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(agentsStatus(fixture.environment)).toMatchObject({
        provider: "ocg-main",
        model: "deepseek-v4-flash",
      });
      expect(readFileSync(fixture.rolePath, "utf8"))
        .toContain('model_provider = "ocg-main"');
    } finally {
      releaseFirst();
      fixture.remove();
    }
  });

  it("rolls back the role file when the config transaction fails", async () => {
    const fixture = createFixture();
    try {
      writeProviderFixture(fixture, deepseekProviderDefinition, "switching");
      await expect(configureThirdPartyRole(
        "deepseek",
        undefined,
        fixture.environment,
        { updateConfig: vi.fn(async () => { throw new Error("version conflict"); }) },
      )).rejects.toThrow("version conflict");
      expect(existsSync(fixture.rolePath)).toBe(false);
    } finally {
      fixture.remove();
    }
  });
});

function managementProviders(): ThirdPartyAgentProvider[] {
  return [{
    provider: "deepseek",
    displayName: "DeepSeek",
    model: "deepseek-v4-flash-vision-exp",
    reasoningEffort: "high",
    mode: "switching",
    models: [{
      model: "deepseek-v4-flash-vision-exp",
      displayName: "DeepSeek V4 Flash Vision",
      contextWindow: 1_048_576,
      reasoningEffort: "high",
      reasoningEfforts: [{ effort: "high", description: "High" }],
    }, {
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1_048_576,
      reasoningEffort: "high",
      reasoningEfforts: [{ effort: "high", description: "High" }],
    }],
  }];
}

function unconfiguredManagementStatus() {
  return {
    configPath: "/private/config.toml",
    roleConfigPath: "/private/sf-agent.config.toml",
    multiAgentV2Enabled: false,
    externalRoleConfigured: false,
    legacyDsRoleConfigured: false,
  };
}

function createFixture() {
  const home = mkdtempSync(join(tmpdir(), "codexc-agents-"));
  const connectHome = join(home, ".codex-connect");
  const environment = { ...process.env, CODEX_HOME: home, CODEX_CONNECT_HOME: connectHome };
  return {
    home,
    connectHome,
    environment,
    configPath: join(home, "config.toml"),
    rolePath: join(home, "sf-agent.config.toml"),
    providerDirectory: (definition: ModelProviderDefinition) =>
      join(connectHome, "providers", definition.storageId ?? definition.id),
    remove: () => rmSync(home, { recursive: true, force: true }),
  };
}

function writeProviderFixture(
  fixture: ReturnType<typeof createFixture>,
  definition: ModelProviderDefinition,
  mode: "switching" | "exclusive",
) {
  const providerDirectory = fixture.providerDirectory(definition);
  mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") securePrivateDirectorySync(providerDirectory);
  const catalogPath = join(providerDirectory, definition.catalogFileName);
  writeFileSync(
    catalogPath,
    JSON.stringify({
      models: definition.models.map(({ slug }: { slug: string }) => ({
        slug,
        display_name: slug,
        context_window: 1_048_576,
        default_reasoning_level: definition.defaultReasoningEffort,
        supported_reasoning_levels: [
          { effort: "high", description: "High" },
          { effort: "max", description: "Max" },
        ],
      })),
    }),
    { mode: 0o600 },
  );
  if (process.platform === "win32") securePrivateFileSync(catalogPath);
  const profile = createManagedProviderProfile(definition, {
    apiKey: "sk-test-secret",
    catalogPath,
  });
  if (mode === "exclusive") delete profile.model_reasoning_effort;
  const target = mode === "exclusive"
    ? join(fixture.home, "config.toml")
    : join(fixture.home, definition.profileFileName);
  writeFileSync(target, stringify(profile), { mode: 0o600 });
  if (process.platform === "win32") securePrivateFileSync(target);
  if (definition.accountId !== undefined) {
    const accountsDirectory = join(providerDirectory, "accounts");
    const accountDirectory = join(accountsDirectory, definition.accountId);
    mkdirSync(accountDirectory, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") securePrivateDirectorySync(accountsDirectory);
    if (process.platform === "win32") securePrivateDirectorySync(accountDirectory);
    if (!existsSync(join(providerDirectory, "accounts.json"))) {
      writeFileSync(
        join(providerDirectory, "accounts.json"),
        `${JSON.stringify([{
          id: definition.accountId,
          default: true,
          ...(definition.email === undefined ? {} : { email: definition.email }),
          ...(definition.phone === undefined ? {} : { phone: definition.phone }),
        }], null, 2)}\n`,
        { mode: 0o600 },
      );
      if (process.platform === "win32") {
        securePrivateFileSync(join(providerDirectory, "accounts.json"));
      }
    }
    writeFileSync(
      join(accountDirectory, definition.managedMarkerFileName),
      stringify(createManagedProviderMarker(definition, mode)),
      { mode: 0o600 },
    );
    if (process.platform === "win32") {
      securePrivateFileSync(join(accountDirectory, definition.managedMarkerFileName));
    }
  } else {
    writeFileSync(
      join(providerDirectory, definition.managedMarkerFileName),
      stringify(createManagedProviderMarker(definition, mode)),
      { mode: 0o600 },
    );
    if (process.platform === "win32") {
      securePrivateFileSync(join(providerDirectory, definition.managedMarkerFileName));
    }
  }
}

function opencodeGoMainDefinition(): ModelProviderDefinition {
  return {
    id: opencodeGoProviderId("main") as ManagedModelProviderId,
    accountId: "main",
    email: "user@example.com",
    storageId: "opencode-go",
    displayName: "ocg-user@example.com",
    profileName: "sf-ocg-main",
    profileFileName: "sf-ocg-main.config.toml",
    catalogFileName: "models.json",
    catalogManifestFileName: "models.manifest.json",
    managedMarkerFileName: "managed.toml",
    backupDirectoryName: "backup",
    baseUrl: "https://opencode.ai/zen/go/v1",
    wireApi: "responses" as const,
    apiKeyEnvironmentKey: opencodeGoApiKeyEnvironmentKey("main"),
    defaultModel: "deepseek-v4-flash",
    defaultReasoningEffort: "high",
    supportsWebsockets: false,
    capabilities: opencodeGoProviderDefinition.capabilities,
    models: [
      { slug: "deepseek-v4-flash", available: true },
      { slug: "deepseek-v4-pro", available: true },
    ],
  };
}

const applyConfigUpdate: CodexUserConfigWriter = async (environment, createEdits) => {
  const configPath = join(String(environment.CODEX_HOME), "config.toml");
  const document = existsSync(configPath)
    ? record(parse(readFileSync(configPath, "utf8")))
    : {};
  const edits = createEdits(document);
  for (const edit of edits) applyEdit(document, edit);
  writePrivateFileAtomicSync(configPath, stringify(document));
};

function applyEdit(
  document: Record<string, CodexUserConfigValue | undefined>,
  edit: { keyPath: string; value: CodexUserConfigValue },
) {
  if (edit.keyPath === "features.multi_agent_v2") {
    const features = record(document.features);
    features.multi_agent_v2 = edit.value;
    document.features = features;
    return;
  }
  if (edit.keyPath === "agents.external") {
    const agents = record(document.agents);
    if (edit.value === null) delete agents.external;
    else agents.external = edit.value;
    if (Object.keys(agents).length === 0) delete document.agents;
    else document.agents = agents;
    return;
  }
  if (edit.keyPath === "agents.ds") {
    const agents = record(document.agents);
    if (edit.value === null) delete agents.ds;
    else agents.ds = edit.value;
    document.agents = agents;
    return;
  }
  throw new Error(`测试配置事务不支持：${edit.keyPath}`);
}

function record(value: unknown): Record<string, CodexUserConfigValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, CodexUserConfigValue | undefined>
    : {};
}
