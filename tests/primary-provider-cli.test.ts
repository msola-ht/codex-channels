import { describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CodexUserConfigValue } from "../scripts/codex-user-config.mjs";
import {
  listPrimaryProviders,
  removePrimaryProvider,
  runCustomPrimaryProviderMenu,
  runPrimaryProviderCli,
  switchPrimaryProvider,
} from "../scripts/primary-provider-cli.mjs";
import {
  backupPrimaryProviderCandidates,
  customPrimaryProviderProfilePath,
  loadCustomSwitchingProviderIds,
  primaryProviderBackupPath,
  readPrimaryProviderBackup,
  writeCustomPrimaryProviderSwitchingProfile,
  writeThirdPartyModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import { secureTestDirectory } from "./support/windows-fixtures.js";

const officialModels = ["gpt-5.6-sol", "model-a", "model-new", "model-old"].map((model) => ({
  model,
  displayName: model,
  supportedReasoningEfforts: [{ effort: "high", description: "High" }],
  defaultReasoningEffort: "high",
  isDefault: model === "gpt-5.6-sol",
}));

function isolatedEnvironment(prefix: string): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const codexHome = join(root, "codex");
  const connectHome = join(root, "connect");
  secureTestDirectory(codexHome);
  secureTestDirectory(connectHome);
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
}

function environmentForConnectHome(connectHome: string): NodeJS.ProcessEnv {
  const codexHome = join(connectHome, "codex");
  secureTestDirectory(codexHome);
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
}

function clientFixture(snapshot: {
  config: Record<string, CodexUserConfigValue | undefined>;
  version: string;
}) {
  const writeUserConfigEdits = vi.fn<
    (
      edits: Array<{ keyPath: string; value: unknown }>,
      options?: { expectedVersion?: string },
    ) => Promise<void>
  >(async () => undefined);
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listModels: vi.fn(async () => officialModels),
    readUserConfigSnapshot: vi.fn(async () => snapshot),
    writeUserConfigEdits,
  };
  return {
    client,
    createClient: vi.fn(async () => client),
    writeUserConfigEdits,
  };
}

describe("primary provider CLI", () => {
  it("lists the active primary and all custom candidates", async () => {
    const { client, createClient } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            name: "OpenAI",
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
          thirdparty: {
            name: "Third-party",
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await listPrimaryProviders({
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output,
      createClient,
    });

    expect(client.readUserConfigSnapshot).toHaveBeenCalledOnce();
    expect(output.write.mock.calls.flat().join("")).toContain(
      "当前主实例：OpenAI · 自定义固定模式",
    );
    expect(output.write.mock.calls.flat().join("")).toContain(
      "Third-party（thirdparty）· https://third.example.test/v1",
    );
  });

  it("lists providers as JSON without exposing credentials", async () => {
    const { createClient } = clientFixture({
      config: {
        model_provider: "thirdparty",
        model_providers: {
          thirdparty: {
            name: "Third-party",
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
            experimental_bearer_token: "sk-secret",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await runPrimaryProviderCli(["list", "--json"], {
      environment: isolatedEnvironment("codexc-primary-provider-json-"),
      output,
      createClient,
    });

    const value = JSON.parse(output.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(value.active).toMatchObject({ id: "thirdparty", mode: "exclusive" });
    expect(value.fixedCandidates).toEqual([expect.objectContaining({
      id: "thirdparty",
      baseUrl: "https://third.example.test/v1",
      active: true,
    })]);
    expect(JSON.stringify(value)).not.toContain("sk-secret");
  });

  it("lists switching providers as JSON without exposing profile credentials", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-json-switching-");
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "gpt-5.6-sol",
      name: "Third-party",
      baseUrl: "https://switch.example.test/v1",
      apiKey: "sk-switch-secret",
    }, environment);
    const { createClient } = clientFixture({
      config: { model_provider: "openai", model_providers: {} },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await runPrimaryProviderCli(["list", "--json"], {
      environment,
      output,
      createClient,
    });

    const value = JSON.parse(output.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(value.active).toMatchObject({ id: "openai", mode: "switching" });
    expect(value.switchingProviders).toEqual([{
      id: "thirdparty",
      name: "Third-party",
      baseUrl: "https://switch.example.test/v1",
      profileName: "sf-custom-thirdparty",
    }]);
    expect(JSON.stringify(value)).not.toContain("sk-switch-secret");
  });

  it("does not expose credentials from a legacy backup URL in JSON", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-json-backup-");
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third-party",
        base_url: "https://user:password@third.example.test/v1",
        wire_api: "responses",
      },
    }, environment);
    const { createClient } = clientFixture({
      config: { model_providers: {} },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await runPrimaryProviderCli(["list", "--json"], {
      environment,
      output,
      createClient,
    });

    const value = JSON.parse(output.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(value.backupCandidates).toEqual([expect.objectContaining({
      id: "thirdparty",
      baseUrl: "",
    })]);
    expect(JSON.stringify(value)).not.toContain("user:password");
  });

  it.each([
    ["stale-provider", "unknown"],
    ["openai", "official"],
  ] as const)("reports active provider mode for %s", async (providerId, mode) => {
    const { createClient } = clientFixture({
      config: {
        model_provider: providerId,
        model_providers: {},
      },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await runPrimaryProviderCli(["list", "--json"], {
      environment: isolatedEnvironment("codexc-primary-provider-json-state-"),
      output,
      createClient,
    });

    expect(JSON.parse(output.write.mock.calls.map(([chunk]) => chunk).join("")))
      .toMatchObject({ active: { id: providerId, mode } });
  });

  it("switches to a configured candidate and optionally updates the model", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await switchPrimaryProvider("thirdparty", "model-a", {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output,
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "thirdparty" },
      { keyPath: "model", value: "model-a" },
    ], { expectedVersion: "v1" });
    expect(output.write.mock.calls.flat().join("")).toContain(
      "已设为固定主 Provider：thirdparty",
    );
  });

  it("rejects fixed mode while another custom switching Profile remains", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-switch-other-");
    const config = {
      model_provider: "openai",
      model_providers: {
        first: {
          base_url: "https://first.example.test/v1",
          wire_api: "responses",
        },
        second: {
          base_url: "https://second.example.test/v1",
          wire_api: "responses",
        },
      },
    };
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "first",
      model: "model-old",
      name: "First",
      baseUrl: "https://first.example.test/v1",
      apiKey: "sk-first",
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({ config, version: "v1" });

    await expect(switchPrimaryProvider("second", "model-a", {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("请先删除其他自定义切换 Provider：first");

    expect(writeUserConfigEdits).not.toHaveBeenCalled();
    expect(existsSync(customPrimaryProviderProfilePath(environment, "first"))).toBe(true);
  });

  it("restores the target custom switching Profile when fixed switching fails", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-switch-other-rollback-");
    const config = {
      model_provider: "openai",
      model_providers: {
        first: {
          base_url: "https://first.example.test/v1",
          wire_api: "responses",
        },
        second: {
          base_url: "https://second.example.test/v1",
          wire_api: "responses",
        },
      },
    };
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "second",
      model: "model-old",
      name: "Second",
      baseUrl: "https://second.example.test/v1",
      apiKey: "sk-second",
    }, environment);
    const profilePath = customPrimaryProviderProfilePath(environment, "second");
    writeFileSync(profilePath, `${readFileSync(profilePath, "utf8")}\n# 保留原始 Profile 内容\n`, {
      mode: 0o600,
    });
    const previousProfile = readFileSync(profilePath, "utf8");
    const { createClient, writeUserConfigEdits } = clientFixture({ config, version: "v1" });
    writeUserConfigEdits.mockImplementationOnce(async () => {
      expect(existsSync(profilePath)).toBe(false);
      throw new Error("config write failed");
    });

    await expect(switchPrimaryProvider("second", "model-a", {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("config write failed");

    expect(readFileSync(profilePath, "utf8")).toBe(previousProfile);
  });

  it("does not remove a Profile changed concurrently before fixed switching", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-profile-concurrent-");
    const config = {
      model_provider: "openai",
      model_providers: {},
    };
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "second",
      model: "model-old",
      name: "Second",
      baseUrl: "https://second.example.test/v1",
      apiKey: "sk-second",
    }, environment);
    const { client, createClient, writeUserConfigEdits } = clientFixture({
      config,
      version: "v1",
    });
    client.connect
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        writeCustomPrimaryProviderSwitchingProfile({
          provider: "second",
          model: "model-new",
          name: "Second New",
          baseUrl: "https://new.example.test/v1",
          apiKey: "sk-second-new",
        }, environment);
      });

    await expect(switchPrimaryProvider("second", "model-a", {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("Profile 在事务期间发生变化");

    expect(writeUserConfigEdits).not.toHaveBeenCalled();
    expect(readFileSync(
      customPrimaryProviderProfilePath(environment, "second"),
      "utf8",
    )).toContain('model = "model-new"');
  });

  it("keeps the Profile removed when a committed fixed switch loses its response", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-switch-committed-");
    const config: Record<string, CodexUserConfigValue | undefined> = {
      model_provider: "openai",
      model_providers: {
        first: {
          base_url: "https://first.example.test/v1",
          wire_api: "responses",
        },
        second: {
          base_url: "https://second.example.test/v1",
          wire_api: "responses",
        },
      },
    };
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "second",
      model: "model-old",
      name: "Second",
      baseUrl: "https://second.example.test/v1",
      apiKey: "sk-second",
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({ config, version: "v1" });
    writeUserConfigEdits.mockImplementationOnce(async () => {
      config.model_provider = "second";
      config.model = "model-a";
      throw new Error("config response lost");
    });

    await expect(switchPrimaryProvider("second", "model-a", {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).resolves.toBeUndefined();

    expect(existsSync(customPrimaryProviderProfilePath(environment, "second"))).toBe(false);
  });

  it("does not restore a switching Profile after an incompatible concurrent config change", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-switch-concurrent-");
    const config: Record<string, CodexUserConfigValue | undefined> = {
      model_provider: "openai",
      model_providers: {
        first: {
          base_url: "https://first.example.test/v1",
          wire_api: "responses",
        },
        second: {
          base_url: "https://second.example.test/v1",
          wire_api: "responses",
        },
      },
    };
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "second",
      model: "model-old",
      name: "Second",
      baseUrl: "https://second.example.test/v1",
      apiKey: "sk-second",
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({ config, version: "v1" });
    writeUserConfigEdits.mockImplementationOnce(async () => {
      config.model_provider = "unrelated";
      throw new Error("config write failed");
    });

    await expect(switchPrimaryProvider("second", "model-a", {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("config write failed");

    expect(existsSync(customPrimaryProviderProfilePath(environment, "second"))).toBe(false);
  });

  it("preserves a concurrently recreated Profile instead of overwriting it during rollback", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-rollback-concurrent-");
    const config = {
      model_provider: "openai",
      model_providers: {},
    };
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "second",
      model: "model-old",
      name: "Second",
      baseUrl: "https://second.example.test/v1",
      apiKey: "sk-second",
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({ config, version: "v1" });
    writeUserConfigEdits.mockImplementationOnce(async () => {
      writeCustomPrimaryProviderSwitchingProfile({
        provider: "second",
        model: "model-new",
        name: "Second New",
        baseUrl: "https://new.example.test/v1",
        apiKey: "sk-second-new",
      }, environment);
      throw new Error("config write failed");
    });

    await expect(switchPrimaryProvider("second", "model-a", {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("Profile 回滚失败");

    expect(readFileSync(
      customPrimaryProviderProfilePath(environment, "second"),
      "utf8",
    )).toContain('model = "model-new"');
  });

  it("keeps the current model when switching without a model argument", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });

    await switchPrimaryProvider("thirdparty", undefined, {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output: { write: vi.fn() },
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "thirdparty" },
    ], { expectedVersion: "v1" });
  });

  it("switches back to official without login and backs up custom candidates", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-official-"));
    const environment = environmentForConnectHome(connectHome);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "custom-only-model",
        model_provider: "OpenAI",
        openai_base_url: "https://api.openai.com/v1",
        model_providers: {
          OpenAI: {
            name: "OpenAI",
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await switchPrimaryProvider("openai", undefined, {
      environment,
      output,
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "openai_base_url", value: null },
      { keyPath: "model_provider", value: "openai" },
      { keyPath: "model", value: null },
      { keyPath: "model_providers.OpenAI", value: null },
      { keyPath: "model_providers.thirdparty", value: null },
    ], { expectedVersion: "v1" });
    expect(output.write.mock.calls.flat().join("")).toContain(
      "自定义候选已移入私有备份：OpenAI、thirdparty",
    );
    const backup = JSON.parse(
      readFileSync(primaryProviderBackupPath({ CODEX_CONNECT_HOME: connectHome }), "utf8"),
    );
    expect(backup.OpenAI.base_url).toBe("https://zzone.cc.cd/v1");
    expect(backup.thirdparty.base_url).toBe("https://third.example.test/v1");
  });

  it("refuses to replace a fixed custom Provider still used by agents.external", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-role-switch-");
    const config = {
      model: "gpt-5.6-sol",
      model_provider: "codeproxy-fixed",
      model_reasoning_effort: "medium",
      model_providers: {
        "codeproxy-fixed": {
          name: "CodeProxy Fixed",
          base_url: "https://fixed.example.test/v1",
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: false,
          experimental_bearer_token: "custom-fixed-secret",
        },
      },
    };
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), [
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
    writeThirdPartyModelProviderRoleConfig(environment, { provider: "codeproxy-fixed" });
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), [
      readFileSync(join(environment.CODEX_HOME!, "config.toml"), "utf8").trimEnd(),
      "",
      "[agents.external]",
      `config_file = ${JSON.stringify(join(environment.CODEX_HOME!, "sf-agent.config.toml"))}`,
      "",
    ].join("\n"), { mode: 0o600 });
    const { createClient, writeUserConfigEdits } = clientFixture({ config, version: "v1" });

    await expect(switchPrimaryProvider("openai", undefined, {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("正由 agents.external 使用");

    expect(writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("keeps the configured model when the primary Provider is already official", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        model_provider: "openai",
        model_providers: {},
      },
      version: "v1",
    });

    await switchPrimaryProvider("openai", undefined, {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output: { write: vi.fn() },
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "openai" },
    ], { expectedVersion: "v1" });
  });

  it("restores a backed-up candidate when switching back to custom", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-restore-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      OpenAI: {
        name: "OpenAI",
        base_url: "https://zzone.cc.cd/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-restore-secret",
      },
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        model_provider: "openai",
        model_providers: {},
      },
      version: "v1",
    });
    writeUserConfigEdits.mockImplementationOnce(async () => {
      expect(readPrimaryProviderBackup(environment)).toHaveProperty(
        "OpenAI.experimental_bearer_token",
        "sk-restore-secret",
      );
    });
    const output = { write: vi.fn() };

    await switchPrimaryProvider("OpenAI", undefined, {
      environment,
      output,
      createClient,
    });

    expect(output.write.mock.calls.flat().join("")).toContain(
      "从备份恢复自定义主 Provider：OpenAI",
    );
    const edits = writeUserConfigEdits.mock.calls[0]?.[0] ?? [];
    expect(edits).toContainEqual({ keyPath: "model_providers.OpenAI.base_url", value: "https://zzone.cc.cd/v1" });
    expect(edits).toContainEqual({
      keyPath: "model_providers.OpenAI.experimental_bearer_token",
      value: "sk-restore-secret",
    });
    expect(edits).toContainEqual({ keyPath: "model_provider", value: "OpenAI" });
    expect(readPrimaryProviderBackup(environment)).toEqual({});
  });

  it("reports a committed switch when private backup cleanup fails", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-switch-cleanup-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      OpenAI: {
        name: "OpenAI",
        base_url: "https://zzone.cc.cd/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-restore-secret",
      },
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {},
      },
      version: "v1",
    });
    writeUserConfigEdits.mockImplementationOnce(async () => {
      chmodSync(primaryProviderBackupPath(environment), 0o644);
    });
    const output = { write: vi.fn() };

    await expect(switchPrimaryProvider("OpenAI", undefined, {
      environment,
      output,
      createClient,
    })).resolves.toBeUndefined();

    const rendered = output.write.mock.calls.flat().join("");
    expect(rendered).toContain("已设为固定主 Provider：OpenAI");
    expect(rendered).toContain("私有备份清理失败");
  });

  it("removes the conflicting top-level base URL when switching", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        openai_base_url: "https://zzone.example.test/v1",
        model_providers: {
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await switchPrimaryProvider("thirdparty", undefined, {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output,
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "openai_base_url", value: null },
      { keyPath: "model_provider", value: "thirdparty" },
    ], { expectedVersion: "v1" });
    expect(output.write.mock.calls.flat().join("")).toContain(
      "已移除与自定义主 Provider 冲突的顶层 openai_base_url",
    );
  });

  it("rejects switching to an unknown candidate", async () => {
    const { createClient } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });

    await expect(switchPrimaryProvider("missing", undefined, {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("未找到自定义主 Provider：missing");
  });

  it("removes an inactive candidate without touching the active selection", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });

    await removePrimaryProvider("thirdparty", {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output: { write: vi.fn() },
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_providers.thirdparty", value: null },
    ], { expectedVersion: "v1" });
  });

  it("removes a stale custom switching registration whose Profile is missing", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-remove-stale-switching-");
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-old",
      name: "Third Party",
      baseUrl: "https://third.example.test/v1",
      apiKey: "sk-third",
    }, environment);
    rmSync(customPrimaryProviderProfilePath(environment, "thirdparty"));
    backupPrimaryProviderCandidates({
      unrelated: {
        base_url: "https://unrelated.example.test/v1",
        wire_api: "responses",
      },
    }, environment);
    chmodSync(primaryProviderBackupPath(environment), 0o644);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: { model_provider: "openai", model_providers: {} },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await expect(removePrimaryProvider("thirdparty", {
      environment,
      output,
      createClient,
    })).resolves.toBeUndefined();

    expect(loadCustomSwitchingProviderIds(environment)).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
    expect(writeUserConfigEdits).not.toHaveBeenCalled();
    expect(output.write.mock.calls.flat().join("")).toContain(
      "已清理缺失 Profile 的自定义切换 Provider thirdparty",
    );
    expect(output.write.mock.calls.flat().join("")).toContain(
      "私有备份无法安全检查或清理",
    );
  });

  it("removes the same Provider from a switching Profile and the private backup", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-remove-switching-backup-");
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-old",
      name: "Third Party",
      baseUrl: "https://third.example.test/v1",
      apiKey: "sk-current",
    }, environment);
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third Party Old",
        base_url: "https://old.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-old",
      },
    }, environment);
    const { createClient } = clientFixture({
      config: { model_provider: "openai", model_providers: {} },
      version: "v1",
    });

    await removePrimaryProvider("thirdparty", {
      environment,
      output: { write: vi.fn() },
      createClient,
    });

    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(false);
    expect(loadCustomSwitchingProviderIds(environment)).toEqual([]);
    expect(readPrimaryProviderBackup(environment)).toEqual({});
  });

  it("refuses to delete a custom switching Provider still used by agents.external", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-role-remove-");
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "codeproxy-dev",
      model: "gpt-5.6-sol",
      name: "CodeProxy Dev",
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "custom-agent-secret",
    }, environment);
    writeThirdPartyModelProviderRoleConfig(environment, { provider: "codeproxy-dev" });
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), [
      'model_provider = "openai"',
      "",
      "[agents.external]",
      `config_file = ${JSON.stringify(join(environment.CODEX_HOME!, "sf-agent.config.toml"))}`,
      "",
    ].join("\n"), { mode: 0o600 });
    const createClient = vi.fn(async () => {
      throw new Error("App Server should not be required");
    });

    await expect(removePrimaryProvider("codeproxy-dev", {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("正由 agents.external 使用");

    expect(existsSync(customPrimaryProviderProfilePath(environment, "codeproxy-dev"))).toBe(true);
    expect(loadCustomSwitchingProviderIds(environment)).toEqual(["codeproxy-dev"]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("removes the same private backup when cleaning a missing switching Profile", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-remove-stale-backup-");
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-old",
      name: "Third Party",
      baseUrl: "https://third.example.test/v1",
      apiKey: "sk-current",
    }, environment);
    rmSync(customPrimaryProviderProfilePath(environment, "thirdparty"));
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third Party Old",
        base_url: "https://old.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-old",
      },
    }, environment);
    const createClient = vi.fn(async () => {
      throw new Error("App Server should not be required");
    });

    await removePrimaryProvider("thirdparty", {
      environment,
      output: { write: vi.fn() },
      createClient,
    });

    expect(loadCustomSwitchingProviderIds(environment)).toEqual([]);
    expect(readPrimaryProviderBackup(environment)).toEqual({});
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reports partial success when a switching Profile is removed but backup cleanup fails", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-remove-switching-partial-");
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-old",
      name: "Third Party",
      baseUrl: "https://third.example.test/v1",
      apiKey: "sk-current",
    }, environment);
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third Party Old",
        base_url: "https://old.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-old",
      },
    }, environment);
    const { createClient } = clientFixture({
      config: { model_provider: "openai", model_providers: {} },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(async () => {
        chmodSync(primaryProviderBackupPath(environment), 0o644);
        return true;
      }),
    };

    await expect(removePrimaryProvider("thirdparty", {
      environment,
      output,
      prompts,
      confirmRemoval: true,
      createClient,
    })).resolves.toBeUndefined();

    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(false);
    expect(loadCustomSwitchingProviderIds(environment)).toEqual([]);
    expect(output.write.mock.calls.flat().join("")).toContain(
      "已删除，但同名私有备份清理失败",
    );
  });

  it("restores the official primary when removing the active candidate", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "custom-only-model",
        model_provider: "thirdparty",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };

    await removePrimaryProvider("thirdparty", {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output,
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_providers.thirdparty", value: null },
      { keyPath: "model_provider", value: "openai" },
      { keyPath: "model", value: null },
    ], { expectedVersion: "v1" });
    expect(output.write.mock.calls.flat().join("")).toContain(
      "已删除自定义主 Provider thirdparty 并恢复官方 OpenAI 主 Provider",
    );
  });

  it("removes a configured candidate from the private backup too", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-remove-backup-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      thirdparty: {
        base_url: "https://third.example.test/v1",
        wire_api: "responses",
      },
    }, environment);
    const { createClient } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });

    await removePrimaryProvider("thirdparty", {
      environment,
      output: { write: vi.fn() },
      createClient,
    });

    expect(JSON.parse(readFileSync(
      primaryProviderBackupPath(environment),
      "utf8",
    ))).toEqual({});
  });

  it("keeps the private backup when removing the config candidate fails", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-remove-rollback-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      thirdparty: {
        base_url: "https://third.example.test/v1",
        wire_api: "responses",
      },
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    writeUserConfigEdits.mockRejectedValueOnce(new Error("config write failed"));

    await expect(removePrimaryProvider("thirdparty", {
      environment,
      output: { write: vi.fn() },
      createClient,
    })).rejects.toThrow("config write failed");

    expect(readPrimaryProviderBackup(environment)).toHaveProperty("thirdparty");
  });

  it("routes subcommands and rejects unknown ones", async () => {
    const { createClient } = clientFixture({
      config: { model_providers: {} },
      version: "v1",
    });
    await runPrimaryProviderCli(["list"], {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output: { write: vi.fn() },
      createClient,
    });
    expect(createClient).toHaveBeenCalled();
    await expect(runPrimaryProviderCli(["unknown"], {
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output: { write: vi.fn() },
    })).rejects.toThrow("未知子命令：unknown");
  });

  it("describes the official model catalog and fixed-mode conversion in help", async () => {
    const output = { write: vi.fn() };

    await runPrimaryProviderCli(["--help"], { output });

    const rendered = output.write.mock.calls.flat().join("");
    expect(rendered).toContain("Codex 官方模型目录");
    expect(rendered).toContain("转换为固定主 Provider");
    expect(rendered).not.toContain("检测上游 /models");
  });

  it("lists candidates from the setup menu and returns on back", async () => {
    const { createClient } = clientFixture({
      config: {
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("list")
        .mockResolvedValueOnce("back"),
    };

    await expect(runCustomPrimaryProviderMenu({
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output,
      prompts,
      createClient,
      allowBack: true,
    })).resolves.toEqual({ action: "back" });

    expect(output.write.mock.calls.flat().join("")).toContain(
      "当前主实例：OpenAI · 自定义固定模式",
    );
  });

  it("switches and removes candidates from the setup menu", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("switch")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "thirdparty" },
    ], { expectedVersion: "v1" });
  });

  it("confirms before converting a switching Provider into the fixed main Provider", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-menu-convert-");
    writeFileSync(join(environment.CODEX_HOME!, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "gpt-5.6-sol",
      name: "Third Party",
      baseUrl: "https://third.example.test/v1",
      apiKey: "sk-thirdparty",
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: { model_provider: "openai", model_providers: {} },
      version: "v1",
    });
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(async () => false),
      select: vi.fn()
        .mockResolvedValueOnce("switch")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      allowBack: true,
    });

    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Third Party（thirdparty）当前是独立切换 Provider。确认删除独立 Profile，并转换为固定主 Provider？",
      initialValue: false,
    });
    expect(writeUserConfigEdits).not.toHaveBeenCalled();
    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(true);
    expect(prompts.select.mock.calls[0]?.[0]?.options).toContainEqual({
      value: "switch",
      label: "设为固定主 Provider",
      hint: "切换模式将转换为固定模式",
    });
    expect(prompts.select.mock.calls[1]?.[0]?.options).toContainEqual({
      value: "thirdparty",
      label: "Third Party（thirdparty） · https://third.example.test/v1",
      hint: "独立切换模式，将转为固定模式",
    });
  });

  it("shows backed-up candidates with their base URL in the switch menu", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-menu-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      OpenAI: {
        name: "OpenAI",
        base_url: "https://zzone.cc.cd/v1",
        wire_api: "responses",
      },
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {},
      },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("switch")
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    const switchOptions = prompts.select.mock.calls[1]?.[0]?.options ?? [];
    expect(switchOptions).toContainEqual({
      value: "OpenAI",
      label: "OpenAI · https://zzone.cc.cd/v1",
      hint: "从备份恢复",
    });
    const edits = writeUserConfigEdits.mock.calls[0]?.[0] ?? [];
    expect(edits).toContainEqual({ keyPath: "model_provider", value: "OpenAI" });
  });

  it("switches back to official from the setup menu", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-menu-official-"));
    const environment = environmentForConnectHome(connectHome);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("official")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "openai" },
      { keyPath: "model", value: null },
      { keyPath: "model_providers.OpenAI", value: null },
    ], { expectedVersion: "v1" });
    expect(output.write.mock.calls.flat().join("")).toContain(
      "自定义候选已移入私有备份：OpenAI",
    );
  });

  it("removes a candidate from the setup menu", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "thirdparty",
        model_providers: {
          OpenAI: {
            base_url: "https://zzone.cc.cd/v1",
            wire_api: "responses",
          },
          thirdparty: {
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(async () => true),
      select: vi.fn()
        .mockResolvedValueOnce("remove")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_providers.thirdparty", value: null },
      { keyPath: "model_provider", value: "openai" },
      { keyPath: "model", value: null },
    ], { expectedVersion: "v1" });
  });

  it("removes a backed-up candidate from the setup menu while official is active", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-menu-remove-backup-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third Party",
        base_url: "https://third.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-backup-secret",
      },
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {},
      },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(async () => true),
      select: vi.fn()
        .mockResolvedValueOnce("remove")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    expect(readPrimaryProviderBackup(environment)).toEqual({});
    expect(writeUserConfigEdits).not.toHaveBeenCalled();
    expect(output.write.mock.calls.flat().join("")).toContain(
      "已删除备份中的自定义主 Provider：thirdparty",
    );
  });

  it("keeps a backed-up candidate when setup deletion is not confirmed", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-menu-cancel-remove-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third Party",
        base_url: "https://third.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-backup-secret",
      },
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {},
      },
      version: "v1",
    });
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(async () => false),
      select: vi.fn()
        .mockResolvedValueOnce("remove")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      allowBack: true,
    });

    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "确认删除 Third Party（thirdparty）· https://third.example.test/v1？此操作无法撤销。",
      initialValue: false,
    });
    expect(readPrimaryProviderBackup(environment)).toHaveProperty(
      "thirdparty.experimental_bearer_token",
      "sk-backup-secret",
    );
    expect(writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("confirms the latest candidate state before setup deletion", async () => {
    const snapshots = [
      {
        config: {
          model_provider: "openai",
          model_providers: {
            thirdparty: {
              name: "Old Name",
              base_url: "https://old.example.test/v1",
              wire_api: "responses",
            },
          },
        },
        version: "v1",
      },
      {
        config: {
          model_provider: "openai",
          model_providers: {
            thirdparty: {
              name: "New Name",
              base_url: "https://new.example.test/v1",
              wire_api: "responses",
            },
          },
        },
        version: "v2",
      },
    ];
    let snapshotIndex = 0;
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      listModels: vi.fn(async () => officialModels),
      readUserConfigSnapshot: vi.fn(async () =>
        snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!),
      writeUserConfigEdits: vi.fn(async () => undefined),
    };
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(async () => false),
      select: vi.fn()
        .mockResolvedValueOnce("remove")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment: isolatedEnvironment("codexc-primary-provider-test-"),
      output: { write: vi.fn() },
      prompts,
      createClient: vi.fn(async () => client),
      allowBack: true,
    });

    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "确认删除 New Name（thirdparty）· https://new.example.test/v1？此操作无法撤销。",
      initialValue: false,
    });
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("adds a candidate from the setup menu", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-menu-add-");
    const { client, createClient } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
        model_providers: {},
      },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      password: vi.fn(async () => "sk-test-secret"),
      text: vi.fn()
        .mockResolvedValueOnce("https://zzone.cc.cd/v1")
        .mockResolvedValueOnce("gpt-5.6-sol"),
      select: vi.fn()
        .mockResolvedValueOnce("add")
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("exclusive")
        .mockResolvedValueOnce("no")
        .mockResolvedValueOnce("back"),
      confirm: vi.fn(async () => true),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "OpenAI" },
      { keyPath: "model", value: "gpt-5.6-sol" },
      { keyPath: "model_providers.OpenAI.name", value: "OpenAI" },
      { keyPath: "model_providers.OpenAI.base_url", value: "https://zzone.cc.cd/v1" },
      { keyPath: "model_providers.OpenAI.wire_api", value: "responses" },
      { keyPath: "model_providers.OpenAI.requires_openai_auth", value: false },
      { keyPath: "model_providers.OpenAI.supports_websockets", value: false },
      { keyPath: "model_providers.OpenAI.request_max_retries", value: 1 },
      { keyPath: "model_providers.OpenAI.stream_max_retries", value: 0 },
      { keyPath: "model_providers.OpenAI.env_key", value: null },
      {
        keyPath: "model_providers.OpenAI.experimental_bearer_token",
        value: "sk-test-secret",
      },
    ], { expectedVersion: "v1" });
  });

  it("edits a selected candidate without changing its Provider ID", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-menu-edit-");
    const { client, createClient } = clientFixture({
      config: {
        model: "model-old",
        model_provider: "thirdparty",
        model_providers: {
          thirdparty: {
            name: "Third Party",
            base_url: "https://old.example.test/v1",
            wire_api: "responses",
            requires_openai_auth: false,
          },
        },
      },
      version: "v1",
    });
    const prompts = {
      isCancel: () => false,
      password: vi.fn(async () => "sk-new-secret"),
      text: vi.fn()
        .mockResolvedValueOnce("https://new.example.test/v1")
        .mockResolvedValueOnce("New Name")
        .mockResolvedValueOnce("model-new"),
      select: vi.fn()
        .mockResolvedValueOnce("edit")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("exclusive")
        .mockResolvedValueOnce("no")
        .mockResolvedValueOnce("back"),
      confirm: vi.fn(async () => true),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      allowBack: true,
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith(
      expect.arrayContaining([
        { keyPath: "model_provider", value: "thirdparty" },
        { keyPath: "model", value: "model-new" },
        {
          keyPath: "model_providers.thirdparty.base_url",
          value: "https://new.example.test/v1",
        },
      ]),
      { expectedVersion: "v1" },
    );
    expect(client.writeUserConfigEdits.mock.calls[0]?.[0]).not.toContainEqual({
      keyPath: "model_providers.new-example-test",
      value: expect.anything(),
    });
  });

  it("edits a configured candidate from the menu when the private backup is invalid", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-menu-configured-");
    backupPrimaryProviderCandidates({
      backupOnly: {
        name: "Backup Only",
        base_url: "https://backup.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-backup-secret",
      },
    }, environment);
    chmodSync(primaryProviderBackupPath(environment), 0o644);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "model-old",
        model_provider: "thirdparty",
        model_providers: {
          thirdparty: {
            name: "Third Party",
            base_url: "https://api.example.com/v1",
            wire_api: "responses",
            experimental_bearer_token: "sk-existing-secret",
          },
        },
      },
      version: "v1",
    });
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn()
        .mockResolvedValueOnce("https://api.example.com/v1")
        .mockResolvedValueOnce("Third Party")
        .mockResolvedValueOnce("model-old"),
      password: vi.fn(async () => ""),
      select: vi.fn()
        .mockResolvedValueOnce("edit")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("exclusive")
        .mockResolvedValueOnce("no")
        .mockResolvedValueOnce("back"),
      confirm: vi.fn(async () => true),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledOnce();
    expect(output.write.mock.calls.flat().join("")).toContain(
      "私有备份无法读取，仅显示当前配置候选",
    );
  });

  it("fails before switching when the private backup is invalid", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-menu-switch-invalid-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      backupOnly: {
        name: "Backup Only",
        base_url: "https://backup.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-backup-secret",
      },
    }, environment);
    chmodSync(primaryProviderBackupPath(environment), 0o644);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "OpenAI",
        model_providers: {
          OpenAI: {
            name: "OpenAI",
            base_url: "https://api.example.com/v1",
            wire_api: "responses",
          },
          thirdparty: {
            name: "Third Party",
            base_url: "https://third.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const prompts = {
      isCancel: () => false,
      text: vi.fn(),
      password: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("switch")
        .mockResolvedValueOnce("thirdparty"),
    };

    await expect(runCustomPrimaryProviderMenu({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      allowBack: true,
    })).rejects.toThrow("主 Provider 备份无法安全读取");

    expect(writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("edits and activates a backed-up candidate without switching to it first", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-menu-edit-backup-");
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third Party",
        base_url: "https://old.example.test/v1",
        wire_api: "responses",
        requires_openai_auth: false,
        experimental_bearer_token: "sk-backup-secret",
      },
    }, environment);
    const { client, createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {},
      },
      version: "v1",
    });
    writeUserConfigEdits.mockImplementationOnce(async () => {
      expect(readPrimaryProviderBackup(environment)).toHaveProperty(
        "thirdparty.experimental_bearer_token",
        "sk-backup-secret",
      );
    });
    const prompts = {
      isCancel: () => false,
      text: vi.fn()
        .mockResolvedValueOnce("https://old.example.test/v2")
        .mockResolvedValueOnce("Updated Third Party")
        .mockResolvedValueOnce("model-a"),
      password: vi.fn(async () => ""),
      select: vi.fn()
        .mockResolvedValueOnce("edit")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("exclusive")
        .mockResolvedValueOnce("no")
        .mockResolvedValueOnce("back"),
      confirm: vi.fn(async () => true),
    };

    await runCustomPrimaryProviderMenu({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      allowBack: true,
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledTimes(1);
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith(
      expect.arrayContaining([
        { keyPath: "model_provider", value: "thirdparty" },
        { keyPath: "model", value: "model-a" },
        {
          keyPath: "model_providers.thirdparty.base_url",
          value: "https://old.example.test/v2",
        },
        {
          keyPath: "model_providers.thirdparty.experimental_bearer_token",
          value: "sk-backup-secret",
        },
      ]),
      { expectedVersion: "v1" },
    );
    expect(readPrimaryProviderBackup(environment)).toEqual({});
  });

  it("keeps a backed-up candidate when direct editing fails to write config", async () => {
    const environment = isolatedEnvironment("codexc-primary-provider-menu-edit-rollback-");
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third Party",
        base_url: "https://old.example.test/v1",
        wire_api: "responses",
        requires_openai_auth: false,
        experimental_bearer_token: "sk-backup-secret",
      },
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {},
      },
      version: "v1",
    });
    writeUserConfigEdits.mockRejectedValueOnce(new Error("config write failed"));
    const prompts = {
      isCancel: () => false,
      text: vi.fn()
        .mockResolvedValueOnce("https://old.example.test/v2")
        .mockResolvedValueOnce("Updated Third Party")
        .mockResolvedValueOnce("model-a"),
      password: vi.fn(async () => ""),
      select: vi.fn()
        .mockResolvedValueOnce("edit")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("exclusive")
        .mockResolvedValueOnce("no"),
      confirm: vi.fn(async () => true),
    };

    await expect(runCustomPrimaryProviderMenu({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      allowBack: true,
    })).rejects.toThrow("config write failed");

    expect(readPrimaryProviderBackup(environment)).toHaveProperty(
      "thirdparty.experimental_bearer_token",
      "sk-backup-secret",
    );
  });
});
