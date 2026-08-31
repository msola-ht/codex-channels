import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexUserConfigValue } from "../scripts/codex-user-config.mjs";
import {
  PrimaryProviderManagementError,
  applyPrimaryProviderRemoval,
  applyPrimaryProviderSwitch,
  previewPrimaryProviderRemoval,
  previewPrimaryProviderSwitch,
} from "../scripts/primary-provider-management.mjs";
import {
  backupPrimaryProviderCandidates,
  primaryProviderBackupPath,
} from "../runtime/model-provider-runtime.mjs";

function isolatedEnvironment(prefix: string): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const codexHome = join(root, "codex");
  const connectHome = join(root, "connect");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(connectHome, { recursive: true, mode: 0o700 });
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
}

function clientFixture(snapshot: {
  config: Record<string, CodexUserConfigValue | undefined>;
  version: string;
}) {
  const writeUserConfigEdits = vi.fn(async () => undefined);
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    readUserConfigSnapshot: vi.fn(async () => snapshot),
    listModels: vi.fn(async () => [{
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
      isDefault: true,
    }]),
    writeUserConfigEdits,
  };
  return {
    createClient: vi.fn(async () => client),
    writeUserConfigEdits,
  };
}

describe("primary Provider management", () => {
  it("returns a redacted switch preview with an explicit activation", async () => {
    const environment = isolatedEnvironment("primary-provider-management-preview-");
    const { createClient } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {
          codeproxy: {
            name: "CodeProxy",
            base_url: "https://proxy.example.test/v1",
            wire_api: "responses",
            experimental_bearer_token: "secret-must-not-leak",
          },
        },
      },
      version: "v1",
    });

    const preview = await previewPrimaryProviderSwitch(
      { providerId: "codeproxy", model: "gpt-5.6-sol" },
      { environment, createClient },
    );

    expect(preview).toEqual({
      operation: "switch",
      target: {
        id: "codeproxy",
        displayName: "CodeProxy",
        source: "configured",
        baseUrl: "https://proxy.example.test/v1",
        model: "gpt-5.6-sol",
      },
      activation: "restart-all",
      effects: {
        currentProviderId: "openai",
        restoresFromBackup: false,
        convertsSwitchingProfile: false,
        removesTopLevelBaseUrl: false,
        clearsCustomModel: false,
        candidateIdsToBackup: [],
      },
    });
    expect(JSON.stringify(preview)).not.toContain("secret-must-not-leak");
  });

  it("applies a switch and returns a stable structured result", async () => {
    const environment = isolatedEnvironment("primary-provider-management-apply-");
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {
          codeproxy: {
            name: "CodeProxy",
            base_url: "https://proxy.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });

    const result = await applyPrimaryProviderSwitch(
      { providerId: "codeproxy" },
      { environment, createClient },
    );

    expect(result).toMatchObject({
      action: "switched",
      target: { id: "codeproxy", source: "configured" },
      activation: "restart-all",
      warnings: [],
    });
    expect(writeUserConfigEdits).toHaveBeenCalledWith(
      [{ keyPath: "model_provider", value: "codeproxy" }],
      { expectedVersion: "v1" },
    );
  });

  it("uses a stable field error for an unknown Provider", async () => {
    const environment = isolatedEnvironment("primary-provider-management-error-");
    const { createClient } = clientFixture({
      config: { model_provider: "openai", model_providers: {} },
      version: "v1",
    });

    const promise = previewPrimaryProviderSwitch(
      { providerId: "missing" },
      { environment, createClient },
    );

    await expect(promise).rejects.toMatchObject({
      name: "PrimaryProviderManagementError",
      code: "provider-not-found",
      field: "providerId",
    });
    await expect(promise).rejects.toBeInstanceOf(PrimaryProviderManagementError);
  });

  it("rejects a custom model outside the official App Server catalog", async () => {
    const environment = isolatedEnvironment("primary-provider-management-model-");
    const { createClient } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {
          codeproxy: {
            name: "CodeProxy",
            base_url: "https://proxy.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });

    await expect(previewPrimaryProviderSwitch(
      { providerId: "codeproxy", model: "invented-model" },
      { environment, createClient },
    )).rejects.toMatchObject({
      code: "unknown-model",
      field: "model",
    });
  });

  it("removes a backup candidate without requiring a service restart", async () => {
    const environment = isolatedEnvironment("primary-provider-management-backup-");
    backupPrimaryProviderCandidates({
      codeproxy: {
        name: "CodeProxy",
        base_url: "https://proxy.example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "secret-must-not-leak",
      },
    }, environment);
    const { createClient } = clientFixture({
      config: { model_provider: "openai", model_providers: {} },
      version: "v1",
    });

    const preview = await previewPrimaryProviderRemoval(
      { providerId: "codeproxy" },
      { environment, createClient },
    );
    const result = await applyPrimaryProviderRemoval(
      { providerId: "codeproxy" },
      { environment, createClient },
    );

    expect(preview).toMatchObject({
      operation: "remove",
      target: { id: "codeproxy", state: "backup" },
      activation: "none",
    });
    expect(JSON.stringify(preview)).not.toContain("secret-must-not-leak");
    expect(result).toMatchObject({
      action: "removed",
      target: { id: "codeproxy", state: "backup" },
      activation: "none",
      warnings: [],
    });
  });

  it.skipIf(process.platform === "win32")("keeps configured removal as partial success when backup cleanup becomes unavailable", async () => {
    const environment = isolatedEnvironment("primary-provider-management-partial-");
    backupPrimaryProviderCandidates({
      codeproxy: {
        name: "CodeProxy",
        base_url: "https://proxy.example.test/v1",
        wire_api: "responses",
      },
    }, environment);
    const { createClient, writeUserConfigEdits } = clientFixture({
      config: {
        model_provider: "openai",
        model_providers: {
          codeproxy: {
            name: "CodeProxy",
            base_url: "https://proxy.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    });
    const preview = await previewPrimaryProviderRemoval(
      { providerId: "codeproxy" },
      { environment, createClient },
    );
    chmodSync(primaryProviderBackupPath(environment), 0o644);

    const result = await applyPrimaryProviderRemoval(
      { providerId: "codeproxy" },
      { environment, createClient, preview },
    );

    expect(writeUserConfigEdits).toHaveBeenCalledWith(
      [{ keyPath: "model_providers.codeproxy", value: null }],
      { expectedVersion: "v1" },
    );
    expect(result).toMatchObject({
      action: "removed",
      activation: "restart-all",
      warnings: [{ code: "backup-cleanup-failed", providerId: "codeproxy" }],
    });
  });

  it("rejects a confirmed removal after the Provider details change", async () => {
    const environment = isolatedEnvironment("primary-provider-management-stale-preview-");
    const snapshot = {
      config: {
        model_provider: "openai",
        model_providers: {
          codeproxy: {
            name: "CodeProxy",
            base_url: "https://proxy.example.test/v1",
            wire_api: "responses",
          },
        },
      },
      version: "v1",
    } satisfies {
      config: Record<string, CodexUserConfigValue | undefined>;
      version: string;
    };
    const { createClient, writeUserConfigEdits } = clientFixture(snapshot);
    const preview = await previewPrimaryProviderRemoval(
      { providerId: "codeproxy" },
      { environment, createClient },
    );
    snapshot.config.model_providers!.codeproxy = {
      ...snapshot.config.model_providers!.codeproxy,
      name: "Changed Provider",
    };

    await expect(applyPrimaryProviderRemoval(
      { providerId: "codeproxy" },
      { environment, createClient, preview },
    )).rejects.toMatchObject({ code: "stale-preview", field: "preview" });
    expect(writeUserConfigEdits).not.toHaveBeenCalled();
  });
});
