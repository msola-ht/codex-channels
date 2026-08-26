import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import type { CodexUserConfigValue } from "../scripts/codex-user-config.mjs";
import {
  applyCustomPrimaryProviderSave,
  prepareCustomPrimaryProviderSave,
  previewCustomPrimaryProviderSave,
} from "../scripts/custom-primary-provider-management.mjs";
import { PrimaryProviderManagementError } from "../scripts/primary-provider-management.mjs";
import {
  backupPrimaryProviderCandidates,
  customPrimaryProviderProfilePath,
  primaryProviderBackupPath,
} from "../runtime/model-provider-runtime.mjs";

const officialModels = ["gpt-5.6-sol", "model-a"].map((model) => ({
  model,
  displayName: model,
  supportedReasoningEfforts: [{ effort: "medium", description: "Medium" }],
  defaultReasoningEffort: "medium",
  isDefault: model === "gpt-5.6-sol",
}));

function isolatedEnvironment(prefix: string): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const codexHome = join(root, "codex");
  const connectHome = join(root, "connect");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(connectHome, { recursive: true, mode: 0o700 });
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
}

function context(config: Record<string, CodexUserConfigValue | undefined>) {
  return async () => ({ snapshot: { config, version: "v1" }, officialModels });
}

function clientFixture(config: Record<string, CodexUserConfigValue | undefined>) {
  const writeUserConfigEdits = vi.fn(async () => undefined);
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    readUserConfigSnapshot: vi.fn(async () => ({ config, version: "v1" })),
    writeUserConfigEdits,
    listModels: vi.fn(async () => officialModels),
  };
  return { createClient: vi.fn(async () => client), writeUserConfigEdits };
}

describe("custom primary Provider management", () => {
  it("returns a redacted create preview", async () => {
    const environment = isolatedEnvironment("custom-provider-management-preview-");
    const preview = await previewCustomPrimaryProviderSave({
      operation: "create",
      providerId: "OpenAI",
      name: "ignored",
      baseUrl: "https://api.example.test/v1",
      mode: "switching",
      model: "gpt-5.6-sol",
      supportsWebsockets: false,
      credential: { action: "replace", apiKey: "secret-must-not-leak" },
    }, {
      environment,
      loadContext: context({ model_provider: "openai", model_providers: {} }),
    });

    expect(preview).toMatchObject({
      operation: "create",
      provider: {
        id: "OpenAI",
        displayName: "OpenAI",
        mode: "switching",
        hasApiKey: true,
      },
      activation: "restart-all",
      credential: {
        action: "replace",
        storedAsPlaintext: true,
        destination: "private-profile",
      },
    });
    expect(JSON.stringify(preview)).not.toContain("secret-must-not-leak");
  });

  it("applies a fixed Provider through the Codex config transaction", async () => {
    const environment = isolatedEnvironment("custom-provider-management-fixed-");
    const config = { model_provider: "openai", model_providers: {} };
    const { createClient, writeUserConfigEdits } = clientFixture(config);

    const result = await applyCustomPrimaryProviderSave({
      operation: "create",
      providerId: "codeproxy",
      name: "CodeProxy",
      baseUrl: "https://proxy.example.test/v1",
      mode: "exclusive",
      model: "model-a",
      supportsWebsockets: true,
      credential: { action: "replace", apiKey: "replacement-secret" },
    }, { environment, createClient, loadContext: context(config) });

    expect(result).toMatchObject({
      action: "created",
      provider: { id: "codeproxy", mode: "exclusive", hasApiKey: true },
      activation: "restart-all",
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toContain("replacement-secret");
    expect(writeUserConfigEdits).toHaveBeenCalledWith(
      expect.arrayContaining([
        { keyPath: "model_provider", value: "codeproxy" },
        { keyPath: "model", value: "model-a" },
        {
          keyPath: "model_providers.codeproxy.experimental_bearer_token",
          value: "replacement-secret",
        },
      ]),
      { expectedVersion: "v1" },
    );
  });

  it("preserves an existing Key inside a prepared update without returning it", async () => {
    const environment = isolatedEnvironment("custom-provider-management-preserve-");
    backupPrimaryProviderCandidates({
      codeproxy: {
        name: "CodeProxy",
        base_url: "https://proxy.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "existing-secret",
      },
    }, environment);
    const config = { model_provider: "openai", model_providers: {} };
    const prepared = await prepareCustomPrimaryProviderSave({
      operation: "update",
      providerId: "codeproxy",
      name: "CodeProxy",
      baseUrl: "https://proxy.example.test/v2",
      mode: "switching",
      model: "model-a",
      supportsWebsockets: false,
      credential: { action: "preserve" },
    }, { environment, loadContext: context(config) });
    chmodSync(primaryProviderBackupPath(environment), 0o644);

    const result = await prepared.apply();

    expect(JSON.stringify(prepared)).not.toContain("existing-secret");
    expect(JSON.stringify(result)).not.toContain("existing-secret");
    expect(result.warnings).toEqual([
      { code: "backup-cleanup-failed", providerId: "codeproxy" },
    ]);
    const profile = parse(readFileSync(
      customPrimaryProviderProfilePath(environment, "codeproxy"),
      "utf8",
    ));
    expect(profile).toMatchObject({
      model_providers: {
        codeproxy: { experimental_bearer_token: "existing-secret" },
      },
    });
  });

  it("requires replacing the Key when the URL origin changes", async () => {
    const environment = isolatedEnvironment("custom-provider-management-origin-");
    const config = {
      model_provider: "codeproxy",
      model_providers: {
        codeproxy: {
          name: "CodeProxy",
          base_url: "https://old.example.test/v1",
          wire_api: "responses",
          experimental_bearer_token: "existing-secret",
        },
      },
    };

    const promise = previewCustomPrimaryProviderSave({
      operation: "update",
      providerId: "codeproxy",
      name: "CodeProxy",
      baseUrl: "https://new.example.test/v1",
      mode: "exclusive",
      model: "model-a",
      supportsWebsockets: false,
      credential: { action: "preserve" },
    }, { environment, loadContext: context(config) });

    await expect(promise).rejects.toBeInstanceOf(PrimaryProviderManagementError);
    await expect(promise).rejects.toMatchObject({
      code: "api-key-replacement-required",
      field: "credential",
    });
  });
});
