import { describe, expect, it, vi } from "vitest";

import type { CodexUserConfigValue } from "../scripts/codex-user-config.mjs";
import {
  listPrimaryProviders,
  removePrimaryProvider,
  runCustomPrimaryProviderMenu,
  runPrimaryProviderCli,
  switchPrimaryProvider,
} from "../scripts/primary-provider-cli.mjs";

function clientFixture(snapshot: {
  config: Record<string, CodexUserConfigValue | undefined>;
  version: string;
}) {
  const writeUserConfigEdits = vi.fn(async () => undefined);
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
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
      environment: {},
      output,
      createClient,
    });

    expect(client.readUserConfigSnapshot).toHaveBeenCalledOnce();
    expect(output.write.mock.calls.flat().join("")).toContain(
      "当前激活：OpenAI · 自定义",
    );
    expect(output.write.mock.calls.flat().join("")).toContain(
      "Third-party（thirdparty）· https://third.example.test/v1",
    );
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

    await switchPrimaryProvider("thirdparty", "gpt-other", {
      environment: {},
      output,
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "thirdparty" },
      { keyPath: "model", value: "gpt-other" },
    ], { expectedVersion: "v1" });
    expect(output.write.mock.calls.flat().join("")).toContain(
      "已切换到自定义主 Provider：thirdparty",
    );
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
      environment: {},
      output: { write: vi.fn() },
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "thirdparty" },
    ], { expectedVersion: "v1" });
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
      environment: {},
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
      environment: {},
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
      environment: {},
      output: { write: vi.fn() },
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_providers.thirdparty", value: null },
    ], { expectedVersion: "v1" });
  });

  it("restores the official primary when removing the active candidate", async () => {
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model: "gpt-5.6-sol",
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
      environment: {},
      output,
      createClient,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_providers.thirdparty", value: null },
      { keyPath: "model_provider", value: null },
    ], { expectedVersion: "v1" });
    expect(output.write.mock.calls.flat().join("")).toContain(
      "已删除自定义主 Provider thirdparty 并恢复官方 OpenAI 主 Provider",
    );
  });

  it("routes subcommands and rejects unknown ones", async () => {
    const { createClient } = clientFixture({
      config: { model_providers: {} },
      version: "v1",
    });
    await runPrimaryProviderCli(["list"], {
      environment: {},
      output: { write: vi.fn() },
      createClient,
    });
    expect(createClient).toHaveBeenCalled();
    await expect(runPrimaryProviderCli(["unknown"], {
      environment: {},
      output: { write: vi.fn() },
    })).rejects.toThrow("未知子命令：unknown");
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
      confirm: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("list")
        .mockResolvedValueOnce("back"),
    };

    await expect(runCustomPrimaryProviderMenu({
      environment: {},
      output,
      prompts,
      createClient,
      allowBack: true,
    })).resolves.toEqual({ action: "back" });

    expect(output.write.mock.calls.flat().join("")).toContain(
      "当前激活：OpenAI · 自定义",
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
      confirm: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("switch")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment: {},
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "thirdparty" },
    ], { expectedVersion: "v1" });
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
      confirm: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("remove")
        .mockResolvedValueOnce("thirdparty")
        .mockResolvedValueOnce("back"),
    };

    await runCustomPrimaryProviderMenu({
      environment: {},
      output,
      prompts,
      createClient,
      allowBack: true,
    });

    expect(writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_providers.thirdparty", value: null },
      { keyPath: "model_provider", value: null },
    ], { expectedVersion: "v1" });
  });

  it("adds a candidate from the setup menu", async () => {
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
      text: vi.fn()
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("https://zzone.cc.cd/v1")
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("gpt-5.6-sol"),
      select: vi.fn()
        .mockResolvedValueOnce("add")
        .mockResolvedValueOnce("apikey")
        .mockResolvedValueOnce("no")
        .mockResolvedValueOnce("back"),
      confirm: vi.fn(async () => true),
    };

    await runCustomPrimaryProviderMenu({
      environment: {},
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
      { keyPath: "model_providers.OpenAI.requires_openai_auth", value: true },
      { keyPath: "model_providers.OpenAI.supports_websockets", value: false },
    ], { expectedVersion: "v1" });
  });
});
