import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import type {
  CodexUserConfigModelOption,
  CodexUserConfigValue,
} from "../scripts/codex-user-config.mjs";

import {
  backupPrimaryProviderCandidates,
  customPrimaryProviderProfilePath,
  loadConfiguredCustomSwitchingModelProviders,
  primaryProviderBackupPath,
  writeCustomPrimaryProviderSwitchingProfile,
} from "../runtime/model-provider-runtime.mjs";
import { runCustomPrimaryProviderSetup } from "../scripts/custom-primary-provider-setup.mjs";

const officialModels: CodexUserConfigModelOption[] = [
  "gpt-5.6-sol",
  "model-a",
  "model-old",
].map((model) => ({
  model,
  displayName: model,
  supportedReasoningEfforts: [{ effort: "high", description: "High" }],
  defaultReasoningEffort: "high",
  isDefault: model === "gpt-5.6-sol",
}));

function testEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "codexc-custom-provider-setup-"));
  const codexHome = join(root, "codex");
  const connectHome = join(root, "connect");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(connectHome, { recursive: true, mode: 0o700 });
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
}

function clientFixture(
  config: Record<string, CodexUserConfigValue | undefined> = { model_providers: {} },
  writeImplementation: () => Promise<void> = async () => undefined,
) {
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listModels: vi.fn(async () => officialModels),
    readUserConfigSnapshot: vi.fn(async () => ({ config, version: "v1" })),
    writeUserConfigEdits: vi.fn(writeImplementation),
  };
  return { client, createClient: vi.fn(async () => client) };
}

function promptFixture({
  texts = [],
  selects = [],
  passwords = ["sk-test-secret"],
  confirms = [true],
}: {
  texts?: unknown[];
  selects?: unknown[];
  passwords?: unknown[];
  confirms?: unknown[];
}) {
  return {
    isCancel: () => false,
    text: vi.fn(async () => texts.shift()),
    select: vi.fn(async () => selects.shift()),
    password: vi.fn(async () => passwords.shift()),
    confirm: vi.fn(async () => confirms.shift()),
  };
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeMainConfig(environment: NodeJS.ProcessEnv, content: string): void {
  writePrivate(join(environment.CODEX_HOME!, "config.toml"), content);
}

function switchingMainConfig(): string {
  return 'model_provider = "openai"\n';
}

describe("custom primary Provider setup", () => {
  it("rejects a remote HTTP base URL before requesting an API key", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture();
    const prompts = promptFixture({ texts: ["http://api.example.test/v1"] });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).rejects.toThrow("远程地址必须使用 HTTPS");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("does not treat a hostname beginning with 127 as a loopback address", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture();
    const prompts = promptFixture({ texts: ["http://127.evil.test/v1"] });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).rejects.toThrow("远程地址必须使用 HTTPS");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("writes a URL-derived Provider in fixed mode without a switching Profile", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({ model_providers: {} });
    const output = { write: vi.fn() };
    const prompts = promptFixture({
      texts: ["http://127.0.0.1:11434/v1", "Local Provider", "model-a"],
      selects: ["127-0-0-1", "exclusive", "no"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output,
      prompts,
      createClient,
    })).resolves.toEqual({ provider: "127-0-0-1", model: "model-a" });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith(
      expect.arrayContaining([
        { keyPath: "model_provider", value: "127-0-0-1" },
        { keyPath: "model", value: "model-a" },
        {
          keyPath: "model_providers.127-0-0-1.base_url",
          value: "http://127.0.0.1:11434/v1",
        },
        {
          keyPath: "model_providers.127-0-0-1.experimental_bearer_token",
          value: "sk-test-secret",
        },
        {
          keyPath: "model_providers.127-0-0-1.request_max_retries",
          value: 1,
        },
        {
          keyPath: "model_providers.127-0-0-1.stream_max_retries",
          value: 0,
        },
      ]),
      { expectedVersion: "v1" },
    );
    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(false);
    const rendered = output.write.mock.calls.flat().join("");
    expect(rendered).toContain("明文写入 0600 主配置");
    expect(rendered).toContain("新 Thread 使用该固定 Provider");
  });

  it("offers the exact OpenAI ID and writes switching mode with the official catalog", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      model: "gpt-5.6-sol",
      model_provider: "openai",
      model_providers: {},
    }, async () => {
      expect(existsSync(customPrimaryProviderProfilePath(environment, "OpenAI"))).toBe(false);
    });
    const output = { write: vi.fn() };
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "gpt-5.6-sol"],
      selects: ["OpenAI", "switching", "no"],
    });

    await runCustomPrimaryProviderSetup({
      environment,
      output,
      prompts,
      createClient,
    });

    expect(prompts.select).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: "Provider ID",
      options: [
        expect.objectContaining({ value: "api-example-test" }),
        expect.objectContaining({ value: "OpenAI" }),
      ],
    }));
    expect(prompts.select).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: "运行模式",
      initialValue: "switching",
    }));
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
    expect(parse(readFileSync(customPrimaryProviderProfilePath(environment, "OpenAI"), "utf8"))).toEqual({
      model: "gpt-5.6-sol",
      model_provider: "OpenAI",
      model_reasoning_effort: "medium",
      service_tier: "default",
      model_providers: {
        OpenAI: {
          name: "OpenAI",
          base_url: "https://api.example.test/v1",
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: false,
          request_max_retries: 1,
          stream_max_retries: 0,
          experimental_bearer_token: "sk-test-secret",
        },
      },
    });
    const rendered = output.write.mock.calls.flat().join("");
    expect(rendered).toContain("模型目录：Codex 官方");
    expect(rendered).toContain("默认思考等级：medium");
    expect(rendered).toContain("服务层级：default");
    expect(rendered).toContain("明文写入 0600 私有 Profile");
    expect(rendered).toContain("主配置：保持官方 OpenAI");
    expect(rendered).toContain("在 /model 选择该 Provider，下一条消息会创建新的 Provider Thread");
    expect(rendered).not.toContain("请用 /new 创建新会话");
  });

  it("rejects converting a main-config candidate directly into switching mode", async () => {
    const environment = testEnvironment();
    writeMainConfig(environment, switchingMainConfig());
    const { client, createClient } = clientFixture({
      model_provider: "openai",
      model_providers: {
        thirdparty: {
          name: "Third Party",
          base_url: "https://api.example.test/v1",
          wire_api: "responses",
          experimental_bearer_token: "sk-existing-secret",
        },
      },
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Third Party"],
      selects: ["switching"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      providerId: "thirdparty",
    })).rejects.toThrow("将主配置候选移入私有备份");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(false);
  });

  it("rejects a manually entered model that is absent from the official catalog", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture();
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Example", "upstream-only-model"],
      selects: ["api-example-test", "exclusive", "no"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).rejects.toThrow("模型 ID 不在 Codex 官方模型目录中");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("rejects an unavailable official catalog model", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture();
    client.listModels.mockResolvedValueOnce([
      { ...officialModels[0]!, available: false },
    ]);
    const prompts = promptFixture({ texts: ["https://api.example.test/v1"] });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).rejects.toThrow("没有返回可用的官方模型");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing Provider ID during add", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      model_providers: {
        OpenAI: {
          base_url: "https://old.example.test/v1",
          wire_api: "responses",
        },
      },
    });
    const output = { write: vi.fn() };
    const prompts = promptFixture({
      texts: ["https://new.example.test/v1"],
      selects: ["OpenAI"],
    });

    await runCustomPrimaryProviderSetup({
      environment,
      output,
      prompts,
      createClient,
    });

    expect(output.write.mock.calls.flat().join("")).toContain("Provider ID OpenAI 已存在");
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("blocks switching mode while another fixed primary Provider is active", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      model_provider: "deepseek",
      model_providers: {},
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Example"],
      selects: ["api-example-test", "switching"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).rejects.toThrow("必须先切回官方 OpenAI");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("blocks switching mode while an implicit fixed primary Provider is active", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      model_providers: {
        thirdparty: {
          name: "Third Party",
          base_url: "https://third.example.test/v1",
          wire_api: "responses",
        },
      },
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Example"],
      selects: ["api-example-test", "switching"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).rejects.toThrow("当前固定主 Provider thirdparty 必须先切回官方 OpenAI");

    expect(prompts.select).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: "运行模式",
      initialValue: "exclusive",
    }));
    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("requires restoring official mode before replacing a managed fixed Provider", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      model_provider: "deepseek",
      model_providers: {},
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Example"],
      selects: ["api-example-test", "exclusive"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).rejects.toThrow("当前受管固定 Provider deepseek 必须先恢复官方模式");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("requires a new API key when an edited Provider changes URL origin", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      model: "model-old",
      model_provider: "thirdparty",
      model_providers: {
        thirdparty: {
          name: "Third Party",
          base_url: "https://old.example.test/v1",
          wire_api: "responses",
          experimental_bearer_token: "sk-existing-secret",
        },
      },
    });
    const prompts = promptFixture({
      texts: ["https://new.example.test/v1", "Third Party", "model-a"],
      selects: ["exclusive"],
      passwords: [""],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      providerId: "thirdparty",
    })).rejects.toThrow("API Key 不能为空");

    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("removes a conflicting top-level OpenAI base URL only after confirmation", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      openai_base_url: "https://official-proxy.example.test/v1",
      model_providers: {},
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "model-a"],
      selects: ["OpenAI", "exclusive", "no"],
      confirms: [true, true],
    });

    await runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    });

    expect(prompts.confirm).toHaveBeenNthCalledWith(1, {
      message: "是否移除顶层 openai_base_url？",
      initialValue: true,
    });
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith(
      expect.arrayContaining([{ keyPath: "openai_base_url", value: null }]),
      { expectedVersion: "v1" },
    );
  });

  it("rejects switching mode with a top-level OpenAI base URL before requesting an API key", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      model_provider: "openai",
      openai_base_url: "https://official-proxy.example.test/v1",
      model_providers: {},
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1"],
      selects: ["OpenAI", "switching"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).rejects.toThrow("请先移除主配置中的 openai_base_url");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("removes the switching Profile when editing the same Provider into fixed mode", async () => {
    const environment = testEnvironment();
    writeMainConfig(environment, switchingMainConfig());
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-old",
      name: "Third Party",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-existing-secret",
    }, environment);
    const { client, createClient } = clientFixture({
      model_provider: "openai",
      model_providers: {
        thirdparty: {
          name: "Third Party",
          base_url: "https://api.example.test/v1",
          wire_api: "responses",
          experimental_bearer_token: "sk-existing-secret",
        },
      },
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Third Party", "model-a"],
      selects: ["exclusive", "no"],
      passwords: [""],
    });

    await runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      providerId: "thirdparty",
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith(
      expect.arrayContaining([
        { keyPath: "model_provider", value: "thirdparty" },
        { keyPath: "model", value: "model-a" },
        {
          keyPath: "model_providers.thirdparty.experimental_bearer_token",
          value: "sk-existing-secret",
        },
      ]),
      { expectedVersion: "v1" },
    );
    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(false);
  });

  it("rejects fixed mode while another custom switching Profile remains", async () => {
    const environment = testEnvironment();
    writeMainConfig(environment, switchingMainConfig());
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "first",
      model: "model-old",
      name: "First",
      baseUrl: "https://first.example.test/v1",
      apiKey: "sk-first",
    }, environment);
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "second",
      model: "model-old",
      name: "Second",
      baseUrl: "https://second.example.test/v1",
      apiKey: "sk-second",
    }, environment);
    const { client, createClient } = clientFixture({
      model_provider: "openai",
      model_providers: {},
    });
    const prompts = promptFixture({
      texts: ["https://second.example.test/v1", "Second"],
      selects: ["exclusive"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      providerId: "second",
    })).rejects.toThrow("请先删除其他自定义切换 Provider：first");

    expect(prompts.password).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
    expect(existsSync(customPrimaryProviderProfilePath(environment, "first"))).toBe(true);
    expect(existsSync(customPrimaryProviderProfilePath(environment, "second"))).toBe(true);
  });

  it("keeps the Profile removed when a committed fixed-mode config loses its response", async () => {
    const environment = testEnvironment();
    writeMainConfig(environment, switchingMainConfig());
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-old",
      name: "Third Party",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-existing-secret",
    }, environment);
    const config: Record<string, CodexUserConfigValue | undefined> = {
      model_provider: "openai",
      model_providers: {
        thirdparty: {
          name: "Third Party",
          base_url: "https://api.example.test/v1",
          wire_api: "responses",
          experimental_bearer_token: "sk-existing-secret",
        },
      },
    };
    const { createClient } = clientFixture(config, async () => {
      config.model_provider = "thirdparty";
      config.model = "model-a";
      config.model_providers = {
        thirdparty: {
          name: "Third Party",
          base_url: "https://api.example.test/v1",
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: false,
          request_max_retries: 1,
          stream_max_retries: 0,
          experimental_bearer_token: "sk-existing-secret",
        },
      };
      throw new Error("config response lost");
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Third Party", "model-a"],
      selects: ["exclusive", "no"],
      passwords: [""],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      providerId: "thirdparty",
    })).resolves.toEqual({ provider: "thirdparty", model: "model-a" });

    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(false);
  });

  it("does not restore the Profile after an incompatible concurrent fixed config change", async () => {
    const environment = testEnvironment();
    writeMainConfig(environment, switchingMainConfig());
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-old",
      name: "Third Party",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-existing-secret",
    }, environment);
    const config: Record<string, CodexUserConfigValue | undefined> = {
      model_provider: "openai",
      model_providers: {},
    };
    const { createClient } = clientFixture(config, async () => {
      config.model_provider = "unrelated";
      throw new Error("config write failed");
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Third Party", "model-a"],
      selects: ["exclusive", "no"],
      passwords: [""],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      providerId: "thirdparty",
    })).rejects.toThrow("config write failed");

    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(false);
  });

  it("updates an existing switching Profile without a main-config transaction", async () => {
    const environment = testEnvironment();
    writeMainConfig(environment, switchingMainConfig());
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "thirdparty",
      model: "model-old",
      name: "Third Party",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-existing-secret",
    }, environment);
    const previousProfile = readFileSync(
      customPrimaryProviderProfilePath(environment, "thirdparty"),
      "utf8",
    );
    const { createClient } = clientFixture({
      model_provider: "openai",
      model_providers: {
        thirdparty: {
          name: "Third Party",
          base_url: "https://api.example.test/v1",
          wire_api: "responses",
          experimental_bearer_token: "sk-existing-secret",
        },
      },
    }, async () => {
      throw new Error("config write failed");
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Third Party", "model-a"],
      selects: ["switching", "no"],
      passwords: [""],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
      providerId: "thirdparty",
    })).resolves.toEqual({ provider: "thirdparty", model: "model-a" });

    expect(readFileSync(customPrimaryProviderProfilePath(environment, "thirdparty"), "utf8"))
      .not.toBe(previousProfile);
    expect(loadConfiguredCustomSwitchingModelProviders(environment)[0]).toMatchObject({
      id: "thirdparty",
      model: "model-a",
      catalogSource: { kind: "official" },
    });
  });

  it("does not write the main config for a new switching Profile", async () => {
    const environment = testEnvironment();
    const { client, createClient } = clientFixture({
      model_provider: "openai",
      model_providers: {},
    });
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "gpt-5.6-sol"],
      selects: ["OpenAI", "switching", "no"],
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output: { write: vi.fn() },
      prompts,
      createClient,
    })).resolves.toEqual({ provider: "OpenAI", model: "gpt-5.6-sol" });

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
    expect(existsSync(customPrimaryProviderProfilePath(environment, "OpenAI"))).toBe(true);
  });

  it("reports a committed switching Profile when private backup cleanup fails", async () => {
    const environment = testEnvironment();
    writeMainConfig(environment, switchingMainConfig());
    backupPrimaryProviderCandidates({
      thirdparty: {
        name: "Third Party",
        base_url: "https://api.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-existing-secret",
      },
    }, environment);
    const { createClient } = clientFixture({
      model_provider: "openai",
      model_providers: {},
    });
    const output = { write: vi.fn() };
    const prompts = promptFixture({
      texts: ["https://api.example.test/v1", "Third Party", "model-a"],
      selects: ["switching", "no"],
      passwords: [""],
    });
    prompts.confirm.mockImplementationOnce(async () => {
      chmodSync(primaryProviderBackupPath(environment), 0o644);
      return true;
    });

    await expect(runCustomPrimaryProviderSetup({
      environment,
      output,
      prompts,
      createClient,
      providerId: "thirdparty",
    })).resolves.toEqual({ provider: "thirdparty", model: "model-a" });

    expect(existsSync(customPrimaryProviderProfilePath(environment, "thirdparty"))).toBe(true);
    expect(output.write.mock.calls.flat().join("")).toContain("私有备份清理失败");
  });
});
