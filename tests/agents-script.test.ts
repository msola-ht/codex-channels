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
  agentsStatus,
  configureThirdPartyRole,
  disableThirdPartyRole,
} from "../scripts/agents.mjs";
import type {
  CodexUserConfigValue,
} from "../scripts/codex-user-config.mjs";
import type { CodexUserConfigWriter } from "../scripts/agents.mjs";
import {
  deepseekProviderDefinition,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import type { ModelProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import {
  createManagedProviderMarker,
  createManagedProviderProfile,
} from "../runtime/model-provider-profile.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";

describe("codexc agents script", () => {
  it.each([
    [deepseekProviderDefinition.id, deepseekProviderDefinition],
    [opencodeGoProviderDefinition.id, opencodeGoProviderDefinition],
  ] as const)("binds the shared role to configured provider %s", async (provider, definition) => {
    const fixture = createFixture();
    try {
      writeProviderFixture(fixture, definition, "switching");

      const selected = await configureThirdPartyRole(
        provider,
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
      writeProviderFixture(fixture, opencodeGoProviderDefinition, "switching");
      await configureThirdPartyRole("deepseek", undefined, fixture.environment, {
        updateConfig: applyConfigUpdate,
      });
      await configureThirdPartyRole("opencode-go", "deepseek-v4-pro", fixture.environment, {
        updateConfig: applyConfigUpdate,
      });

      expect(agentsStatus(fixture.environment)).toMatchObject({
        provider: "opencode-go",
        model: "deepseek-v4-pro",
      });
      expect(parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
        agents: { external: { nickname_candidates: ["OpenCode Go"] } },
      });
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
      writeProviderFixture(fixture, opencodeGoProviderDefinition, "exclusive");

      await configureThirdPartyRole("opencode-go", undefined, fixture.environment, {
        updateConfig: applyConfigUpdate,
      });

      expect(agentsStatus(fixture.environment)).toMatchObject({
        provider: "opencode-go",
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
      join(connectHome, "providers", definition.id),
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
  const profile = createManagedProviderProfile(definition, {
    apiKey: "sk-test-secret",
    catalogPath,
  });
  if (mode === "exclusive") delete profile.model_reasoning_effort;
  const target = mode === "exclusive"
    ? join(fixture.home, "config.toml")
    : join(fixture.home, definition.profileFileName);
  writeFileSync(target, stringify(profile), { mode: 0o600 });
  writeFileSync(
    join(providerDirectory, definition.managedMarkerFileName),
    stringify(createManagedProviderMarker(definition, mode)),
    { mode: 0o600 },
  );
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
