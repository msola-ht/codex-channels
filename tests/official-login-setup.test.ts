import { describe, expect, it, vi } from "vitest";

import { runOfficialLoginSetup } from "../scripts/official-login-setup.mjs";

describe("official login setup", () => {
  it("runs codex login and clears the custom primary configuration", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: {
          model: "gpt-5.6-sol",
          model_provider: "thirdparty",
          openai_base_url: "https://api.openai.com/v1",
          model_providers: {
            thirdparty: { base_url: "https://third.example.test/v1" },
          },
        },
        version: "v1",
      })),
      writeUserConfigEdits: vi.fn(async () => undefined),
    };
    const createClient = vi.fn(async () => client);
    const runLogin = vi.fn();
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      confirm: vi.fn(async () => true),
    };

    const result = await runOfficialLoginSetup({
      environment: {},
      output,
      prompts,
      createClient,
      runLogin,
    });

    expect(result).toEqual({ mode: "official" });
    expect(runLogin).toHaveBeenCalledWith({
      codexBinary: "codex",
      environment: {},
    });
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_providers.thirdparty", value: null },
      { keyPath: "openai_base_url", value: null },
      { keyPath: "model_provider", value: null },
    ], { expectedVersion: "v1" });
  });

  it("cancels without login or configuration changes", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: {
          model: "gpt-5.6-sol",
          model_provider: "thirdparty",
          model_providers: {
            thirdparty: { base_url: "https://third.example.test/v1" },
          },
        },
        version: "v1",
      })),
      writeUserConfigEdits: vi.fn(async () => undefined),
    };
    const createClient = vi.fn(async () => client);
    const runLogin = vi.fn();
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      confirm: vi.fn(async () => false),
    };

    await expect(runOfficialLoginSetup({
      environment: {},
      output,
      prompts,
      createClient,
      runLogin,
    })).resolves.toBeUndefined();

    expect(runLogin).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });
});
