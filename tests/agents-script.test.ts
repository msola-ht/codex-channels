import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import {
  agentsStatus,
  disableDeepseekRole,
  enableDeepseekRole,
  type CodexUserConfigWriter,
} from "../scripts/agents.mjs";
import {
  updateCodexUserConfig,
  type CodexUserConfigEdit,
  type CodexUserConfigValue,
} from "../scripts/codex-user-config.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";

const compatibleUserConfigWriter: CodexUserConfigWriter = updateCodexUserConfig;
void compatibleUserConfigWriter;

describe("codexc agents script", () => {
  it("routes managed role changes through one user config transaction", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-transaction-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const rolePath = join(codexHome, "codex-connect-ds-subagent.config.toml");
    let requestedEdits: CodexUserConfigEdit[] = [];
    const updateConfig = vi.fn(async (
      _environment: NodeJS.ProcessEnv,
      createEdits: (config: Record<string, CodexUserConfigValue | undefined>) => Array<{
        keyPath: string;
        value: CodexUserConfigValue;
      }>,
    ) => {
      requestedEdits = createEdits({});
    });
    try {
      writeProviderFixtures(codexHome);

      await enableDeepseekRole(environment, { updateConfig });

      expect(updateConfig).toHaveBeenCalledWith(environment, expect.any(Function));
      expect(requestedEdits).toEqual([{
        keyPath: "features.multi_agent_v2",
        value: true,
      }, {
        keyPath: "agents.ds",
        value: {
          description:
            "DeepSeek 单次子代理；仅处理当前用户消息中的完整任务，必须使用 fork_turns=1，不能接收后续消息",
          config_file: rolePath,
          nickname_candidates: ["DeepSeek"],
        },
      }]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("enables multi_agent_v2 with a DeepSeek role and disables it again", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const configPath = join(codexHome, "config.toml");
    const rolePath = join(codexHome, "codex-connect-ds-subagent.config.toml");
    try {
      writeFileSync(
        join(codexHome, "codex-connect-deepseek.config.toml"),
        'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
        { mode: 0o600 },
      );
      writeFileSync(join(codexHome, "deepseek.config.toml"), providerProfile(codexHome), {
        mode: 0o600,
      });
      writeFileSync(
        join(codexHome, "deepseek.models.json"),
        '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
        { mode: 0o600 },
      );
      writeFileSync(configPath, "model = \"gpt-5.6-sol\"\n", { mode: 0o600 });
      const originalConfigInode = statSync(configPath).ino;

      await enableDeepseekRole(environment, { updateConfig: applyConfigUpdate });
      const enabledConfig = readFileSync(configPath, "utf8");
      expect(statSync(configPath).ino).not.toBe(originalConfigInode);
      expect(parse(enabledConfig)).toMatchObject({
        model: "gpt-5.6-sol",
        features: { multi_agent_v2: true },
        agents: {
          ds: {
            description:
              "DeepSeek 单次子代理；仅处理当前用户消息中的完整任务，必须使用 fork_turns=1，不能接收后续消息",
            config_file: rolePath,
            nickname_candidates: ["DeepSeek"],
          },
        },
      });
      expect(existsSync(rolePath)).toBe(true);
      expect(readFileSync(rolePath, "utf8")).not.toContain("sk-test-secret");

      expect(agentsStatus(environment)).toMatchObject({
        multiAgentV2Enabled: true,
        dsRoleConfigured: true,
      });

      await disableDeepseekRole(environment, { updateConfig: applyConfigUpdate });
      const disabledConfig = readFileSync(configPath, "utf8");
      expect(parse(disabledConfig)).toMatchObject({
        model: "gpt-5.6-sol",
        features: { multi_agent_v2: false },
      });
      expect(record(parse(disabledConfig).agents).ds).toBeUndefined();
      expect(existsSync(rolePath)).toBe(false);

      expect(agentsStatus(environment)).toMatchObject({
        multiAgentV2Enabled: false,
        dsRoleConfigured: false,
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("turns an existing multi_agent_v2 feature table back on and off", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-table-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const configPath = join(codexHome, "config.toml");
    try {
      writeFileSync(
        join(codexHome, "codex-connect-deepseek.config.toml"),
        'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
        { mode: 0o600 },
      );
      writeFileSync(join(codexHome, "deepseek.config.toml"), providerProfile(codexHome), {
        mode: 0o600,
      });
      writeFileSync(
        join(codexHome, "deepseek.models.json"),
        '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
        { mode: 0o600 },
      );
      writeFileSync(
        configPath,
        "[features.multi_agent_v2]\nenabled = false\n",
        { mode: 0o600 },
      );

      await enableDeepseekRole(environment, { updateConfig: applyConfigUpdate });
      expect(parse(readFileSync(configPath, "utf8"))).toMatchObject({
        features: { multi_agent_v2: true },
      });

      await disableDeepseekRole(environment, { updateConfig: applyConfigUpdate });
      expect(parse(readFileSync(configPath, "utf8"))).toMatchObject({
        features: { multi_agent_v2: false },
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("replaces existing feature keys instead of duplicating them", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-inline-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const configPath = join(codexHome, "config.toml");
    try {
      writeFileSync(
        join(codexHome, "codex-connect-deepseek.config.toml"),
        'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
        { mode: 0o600 },
      );
      writeFileSync(join(codexHome, "deepseek.config.toml"), providerProfile(codexHome), {
        mode: 0o600,
      });
      writeFileSync(
        join(codexHome, "deepseek.models.json"),
        '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
        { mode: 0o600 },
      );
      writeFileSync(
        configPath,
        "[features]\nmulti_agent_v2 = false\nother_feature = true\n",
        { mode: 0o600 },
      );

      await enableDeepseekRole(environment, { updateConfig: applyConfigUpdate });
      expect(parse(readFileSync(configPath, "utf8"))).toMatchObject({
        features: { multi_agent_v2: true, other_feature: true },
      });

      await disableDeepseekRole(environment, { updateConfig: applyConfigUpdate });
      expect(parse(readFileSync(configPath, "utf8"))).toMatchObject({
        features: { multi_agent_v2: false, other_feature: true },
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("refuses to disable a user-managed ds role", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-user-role-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const configPath = join(codexHome, "config.toml");
    const original = [
      "[features]",
      "multi_agent_v2 = true",
      "[agents.ds]",
      'description = "User role"',
      'config_file = "/opt/user/ds.toml"',
      "",
    ].join("\n");
    try {
      writeFileSync(configPath, original, { mode: 0o600 });

      await expect(disableDeepseekRole(environment, {
        updateConfig: applyConfigUpdate,
      })).rejects.toThrow("agents.ds 已由用户配置");

      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("restores the managed role file when the config transaction fails", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-rollback-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const rolePath = join(codexHome, "codex-connect-ds-subagent.config.toml");
    try {
      writeProviderFixtures(codexHome);

      await expect(enableDeepseekRole(environment, {
        updateConfig: vi.fn(async () => {
          throw new Error("config version conflict");
        }),
      })).rejects.toThrow("config version conflict");

      expect(existsSync(rolePath)).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("writes a guarded config transaction with the version read from the same client", async () => {
    const environment = { ...process.env, CODEX_HOME: "/tmp/codexc-config-version" };
    const client = {
      connect: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: { agents: {} },
        version: "sha256:current",
      })),
      writeUserConfigEdits: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await updateCodexUserConfig(
      environment,
      () => [{ keyPath: "agents.ds", value: null }],
      { createClient: vi.fn(async () => client) },
    );

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith(
      [{ keyPath: "agents.ds", value: null }],
      { expectedVersion: "sha256:current" },
    );
  });
});

function providerProfile(codexHome: string): string {
  return [
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    'model_reasoning_effort = "high"',
    `model_catalog_json = ${JSON.stringify(join(codexHome, "deepseek.models.json"))}`,
    "model_auto_compact_token_limit = 629146",
    "model_auto_compact_token_limit_scope = \"total\"",
    "[model_providers.deepseek]",
    'name = "deepseek"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    'experimental_bearer_token = "sk-test-secret"',
    "",
  ].join("\n");
}

function writeProviderFixtures(codexHome: string): void {
  writeFileSync(
    join(codexHome, "codex-connect-deepseek.config.toml"),
    'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
    { mode: 0o600 },
  );
  writeFileSync(join(codexHome, "deepseek.config.toml"), providerProfile(codexHome), {
    mode: 0o600,
  });
  writeFileSync(
    join(codexHome, "deepseek.models.json"),
    '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
    { mode: 0o600 },
  );
}

async function applyConfigUpdate(
  environment: NodeJS.ProcessEnv,
  createEdits: (
    config: Record<string, CodexUserConfigValue | undefined>,
  ) => CodexUserConfigEdit[],
): Promise<void> {
  const configPath = join(String(environment.CODEX_HOME), "config.toml");
  const document = existsSync(configPath)
    ? record(parse(readFileSync(configPath, "utf8")))
    : {};
  const edits = createEdits(document as Record<string, CodexUserConfigValue | undefined>);
  for (const edit of edits) {
    if (edit.keyPath === "features.multi_agent_v2") {
      const features = record(document.features);
      features.multi_agent_v2 = edit.value;
      document.features = features;
      continue;
    }
    if (edit.keyPath === "agents.ds") {
      const agents = record(document.agents);
      if (edit.value === null) {
        delete agents.ds;
      } else {
        agents.ds = edit.value;
      }
      if (Object.keys(agents).length === 0) {
        delete document.agents;
      } else {
        document.agents = agents;
      }
      continue;
    }
    throw new Error(`测试配置事务不支持：${edit.keyPath}`);
  }
  writePrivateFileAtomicSync(configPath, stringify(document));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
