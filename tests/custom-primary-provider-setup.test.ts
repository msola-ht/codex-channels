import { describe, expect, it, vi } from "vitest";

import { runCustomPrimaryProviderSetup } from "../scripts/custom-primary-provider-setup.mjs";

describe("custom primary Provider setup", () => {
  it("writes the custom Provider block through the App Server user config API", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: {
          model: "gpt-5.6-sol",
          model_providers: {},
        },
        version: "v1",
      })),
      writeUserConfigEdits: vi.fn<
        (
          edits: Array<{ keyPath: string; value: unknown }>,
          options?: { expectedVersion?: string },
        ) => Promise<void>
      >(async () => undefined),
    };
    const createClient = vi.fn(async () => client);
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn()
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("https://zzone.cc.cd/v1")
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("gpt-5.6-sol"),
      select: vi.fn()
        .mockResolvedValueOnce("apikey")
        .mockResolvedValueOnce("no"),
      confirm: vi.fn(async () => true),
    };

    const result = await runCustomPrimaryProviderSetup({
      environment: {},
      output,
      prompts,
      createClient,
    });

    expect(result).toEqual({ provider: "OpenAI", model: "gpt-5.6-sol" });
    expect(client.readUserConfigSnapshot).toHaveBeenCalledOnce();
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "OpenAI" },
      { keyPath: "model", value: "gpt-5.6-sol" },
      { keyPath: "model_providers.OpenAI.name", value: "OpenAI" },
      { keyPath: "model_providers.OpenAI.base_url", value: "https://zzone.cc.cd/v1" },
      { keyPath: "model_providers.OpenAI.wire_api", value: "responses" },
      { keyPath: "model_providers.OpenAI.requires_openai_auth", value: true },
      { keyPath: "model_providers.OpenAI.supports_websockets", value: false },
    ], { expectedVersion: "v1" });
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("cancels without writing when the confirmation is declined", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: { model: "gpt-5.6-sol", model_providers: {} },
        version: "v1",
      })),
      writeUserConfigEdits: vi.fn<
        (
          edits: Array<{ keyPath: string; value: unknown }>,
          options?: { expectedVersion?: string },
        ) => Promise<void>
      >(async () => undefined),
    };
    const createClient = vi.fn(async () => client);
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn()
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("https://zzone.cc.cd/v1")
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("gpt-5.6-sol"),
      select: vi.fn()
        .mockResolvedValueOnce("apikey")
        .mockResolvedValueOnce("no"),
      confirm: vi.fn(async () => false),
    };

    await expect(runCustomPrimaryProviderSetup({
      environment: {},
      output,
      prompts,
      createClient,
    })).resolves.toBeUndefined();

    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("removes the top-level base URL while keeping other candidates", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: {
          model: "gpt-5.6-sol",
          model_provider: "thirdparty",
          openai_base_url: "https://api.openai.com/v1",
          model_providers: {
            thirdparty: {
              base_url: "https://old.example.test/v1",
              wire_api: "responses",
            },
            oldone: {
              base_url: "https://older.example.test/v1",
              wire_api: "responses",
            },
          },
        },
        version: "v1",
      })),
      writeUserConfigEdits: vi.fn<
        (
          edits: Array<{ keyPath: string; value: unknown }>,
          options?: { expectedVersion?: string },
        ) => Promise<void>
      >(async () => undefined),
    };
    const createClient = vi.fn(async () => client);
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn()
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("https://zzone.cc.cd/v1")
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("gpt-5.6-sol"),
      select: vi.fn()
        .mockResolvedValueOnce("apikey")
        .mockResolvedValueOnce("no"),
      confirm: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
    };

    const result = await runCustomPrimaryProviderSetup({
      environment: {},
      output,
      prompts,
      createClient,
    });

    expect(result).toEqual({ provider: "OpenAI", model: "gpt-5.6-sol" });
    const edits = vi.mocked(client.writeUserConfigEdits).mock.calls[0]?.[0];
    expect(edits).not.toContainEqual({
      keyPath: "model_providers.thirdparty",
      value: null,
    });
    expect(edits).not.toContainEqual({
      keyPath: "model_providers.oldone",
      value: null,
    });
    expect(edits).toContainEqual({
      keyPath: "openai_base_url",
      value: null,
    });
    expect(edits).toContainEqual({
      keyPath: "model_providers.OpenAI.base_url",
      value: "https://zzone.cc.cd/v1",
    });
  });

  it("keeps other candidates and unrelated blocks when switching the primary", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: {
          model: "gpt-5.6-sol",
          model_provider: "thirdparty",
          model_providers: {
            thirdparty: {
              base_url: "https://old.example.test/v1",
              wire_api: "responses",
            },
            chatapi: {
              base_url: "https://chat.example.test/v1",
              wire_api: "chat_completions",
            },
          },
        },
        version: "v1",
      })),
      writeUserConfigEdits: vi.fn<
        (
          edits: Array<{ keyPath: string; value: unknown }>,
          options?: { expectedVersion?: string },
        ) => Promise<void>
      >(async () => undefined),
    };
    const createClient = vi.fn(async () => client);
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn()
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("https://zzone.cc.cd/v1")
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("gpt-5.6-sol"),
      select: vi.fn()
        .mockResolvedValueOnce("apikey")
        .mockResolvedValueOnce("no"),
      confirm: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
    };

    await runCustomPrimaryProviderSetup({
      environment: {},
      output,
      prompts,
      createClient,
    });

    const edits = vi.mocked(client.writeUserConfigEdits).mock.calls[0]?.[0];
    expect(edits).not.toContainEqual({
      keyPath: "model_providers.chatapi",
      value: null,
    });
    expect(edits).toContainEqual({
      keyPath: "model_provider",
      value: "OpenAI",
    });
  });

  it("clears the stale env_key when switching away from env_key auth", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: {
          model: "gpt-5.6-sol",
          model_provider: "OpenAI",
          model_providers: {
            OpenAI: {
              base_url: "https://zzone.cc.cd/v1",
              wire_api: "responses",
              requires_openai_auth: false,
              env_key: "CODEX_OPENAI_API_KEY",
            },
          },
        },
        version: "v1",
      })),
      writeUserConfigEdits: vi.fn<
        (
          edits: Array<{ keyPath: string; value: unknown }>,
          options?: { expectedVersion?: string },
        ) => Promise<void>
      >(async () => undefined),
    };
    const createClient = vi.fn(async () => client);
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      text: vi.fn()
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("https://zzone.cc.cd/v1")
        .mockResolvedValueOnce("OpenAI")
        .mockResolvedValueOnce("gpt-5.6-sol"),
      select: vi.fn()
        .mockResolvedValueOnce("apikey")
        .mockResolvedValueOnce("no"),
      confirm: vi.fn(async () => true),
    };

    await runCustomPrimaryProviderSetup({
      environment: {},
      output,
      prompts,
      createClient,
    });

    const edits = vi.mocked(client.writeUserConfigEdits).mock.calls[0]?.[0];
    expect(edits).toContainEqual({
      keyPath: "model_providers.OpenAI.requires_openai_auth",
      value: true,
    });
    expect(edits).toContainEqual({
      keyPath: "model_providers.OpenAI.env_key",
      value: null,
    });
  });
});
