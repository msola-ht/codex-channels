import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runOfficialLoginSetup } from "../scripts/official-login-setup.mjs";
import { primaryProviderBackupPath } from "../runtime/model-provider-runtime.mjs";

describe("official login setup", () => {
  it("runs codex login, backs up custom candidates and disables them", async () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-official-login-home-"));
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: {
          model: "custom-only-model",
          model_provider: "thirdparty",
          openai_base_url: "https://api.openai.com/v1",
          model_providers: {
            thirdparty: {
              base_url: "https://third.example.test/v1",
              wire_api: "responses",
            },
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
      environment: { CODEX_CONNECT_HOME: connectHome },
      output,
      prompts,
      createClient,
      runLogin,
    });

    expect(result).toEqual({ mode: "official" });
    expect(runLogin).toHaveBeenCalledWith({
      codexBinary: "codex",
      environment: { CODEX_CONNECT_HOME: connectHome },
    });
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "openai_base_url", value: null },
      { keyPath: "model_provider", value: "openai" },
      { keyPath: "model", value: null },
      { keyPath: "model_providers.thirdparty", value: null },
    ], { expectedVersion: "v1" });
    const backup = JSON.parse(
      readFileSync(primaryProviderBackupPath({ CODEX_CONNECT_HOME: connectHome }), "utf8"),
    );
    expect(backup.thirdparty.base_url).toBe("https://third.example.test/v1");
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

  it("defaults to codex login --device-auth for remote login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codexc-official-login-device-"));
    const argsPath = join(dir, "args.txt");
    const loginScript = join(dir, "fake-codex.sh");
    writeFileSync(loginScript, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > '${argsPath}'`,
    ].join("\n"), { mode: 0o700 });

    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readUserConfigSnapshot: vi.fn(async () => ({
        config: { model_provider: "thirdparty" },
        version: "v1",
      })),
      writeUserConfigEdits: vi.fn(async () => undefined),
    };
    const createClient = vi.fn(async () => client);
    const output = { write: vi.fn() };
    const prompts = {
      isCancel: () => false,
      confirm: vi.fn(async () => true),
    };

    await runOfficialLoginSetup({
      environment: { CODEX_BINARY: loginScript },
      output,
      prompts,
      createClient,
    });

    expect(readFileSync(argsPath, "utf8").trim()).toBe("login --device-auth");
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_provider", value: "openai" },
      { keyPath: "model", value: null },
    ], { expectedVersion: "v1" });
  });
});
