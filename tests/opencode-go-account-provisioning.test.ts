import { describe, expect, it } from "vitest";

import {
  applyOpencodeGoAccountConfiguration,
  previewOpencodeGoAccountConfiguration,
} from "../scripts/opencode-go-account-provisioning.mjs";

describe("OpenCode Go account provisioning", () => {
  it("previews a first switching account without prompts or credentials", async () => {
    const environment = previewEnvironment();
    const preview = await previewOpencodeGoAccountConfiguration({
      accountId: "opencode-go",
      mode: "switching",
    }, {
      environment,
      loadAccounts: () => [],
      loadPrimaryProvider: () => "openai",
    });

    expect(preview).toEqual({
      operation: "add",
      account: {
        id: "opencode-go",
        provider: "opencode-go",
        exists: false,
        default: true,
      },
      mode: "switching",
      effects: {
        writesMainConfig: false,
        writesIsolatedProfile: true,
        downloadsCatalog: true,
        updatesExternalAgent: true,
      },
      confirmation: {
        required: false,
        field: "confirmExclusiveConfigChange",
      },
      activation: "restart-all",
    });
    expect(JSON.stringify(preview)).not.toContain("apiKey");
  });

  it("returns a stable field error for an existing account", async () => {
    await expect(previewOpencodeGoAccountConfiguration({
      accountId: "opencode-go",
      mode: "switching",
    }, {
      environment: previewEnvironment(),
      loadAccounts: () => [{ id: "opencode-go", default: true }],
      loadPrimaryProvider: () => "openai",
    })).rejects.toMatchObject({ code: "account-exists", field: "accountId" });
  });

  it("requires explicit confirmation before fixed-mode configuration", async () => {
    await expect(applyOpencodeGoAccountConfiguration({
      accountId: "opencode-go",
      mode: "exclusive",
      apiKey: "sk-test",
    }, {
      environment: previewEnvironment(),
      loadAccounts: () => [],
      loadPrimaryProvider: () => "openai",
    })).rejects.toMatchObject({
      code: "confirmation-required",
      field: "confirmExclusiveConfigChange",
    });
  });

  it("rejects an invalid API key before downloading the model catalog", async () => {
    await expect(applyOpencodeGoAccountConfiguration({
      accountId: "opencode-go",
      mode: "switching",
      apiKey: "invalid",
    }, {
      environment: previewEnvironment(),
      loadAccounts: () => [],
      loadPrimaryProvider: () => "openai",
    })).rejects.toMatchObject({ code: "invalid-api-key", field: "apiKey" });
  });
});

function previewEnvironment() {
  return {
    CODEX_HOME: "/tmp/codexc-opencode-go-provisioning-preview/codex",
    CODEX_CONNECT_HOME: "/tmp/codexc-opencode-go-provisioning-preview/connect",
  };
}
