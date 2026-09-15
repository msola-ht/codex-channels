import {
  chmodSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCustomPrimaryProviderMenu } from "../scripts/primary-provider-cli.mjs";
import {
  backupPrimaryProviderCandidates,
  customPrimaryProviderProfilePath,
  primaryProviderBackupPath,
  readPrimaryProviderBackup,
  writeCustomPrimaryProviderSwitchingProfile,
} from "../runtime/model-provider-runtime.mjs";
import {
  clientFixture,
  environmentForConnectHome,
  isolatedEnvironment,
  officialModels,
} from "./primary-provider-test-fixture.js";

describe("primary provider setup menu", () => {
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
      confirm: vi.fn(async () => true),
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
      message: "将把主实例切换到 Third Party（thirdparty），移除其独立切换 Profile，并改写 Codex 主配置的 model_provider / model。确认继续？",
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
      confirm: vi.fn(async () => true),
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
      confirm: vi.fn(async () => true),
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

  it.skipIf(process.platform === "win32")("edits a configured candidate from the menu when the private backup is invalid", async () => {
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

  it.skipIf(process.platform === "win32")("fails before switching when the private backup is invalid", async () => {
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
