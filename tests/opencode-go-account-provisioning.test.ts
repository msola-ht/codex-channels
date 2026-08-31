import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyOpencodeGoAccountConfiguration,
  previewOpencodeGoAccountConfiguration,
} from "../scripts/opencode-go-account-provisioning.mjs";
import {
  assertOpencodeGoFileSnapshots,
  refreshOpencodeGoFileSnapshot,
  snapshotOpencodeGoFiles,
} from "../scripts/opencode-go-account-files.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  it.skipIf(process.platform === "win32")("keeps untouched file guards when one transaction file advances", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-opencode-go-guards-"));
    temporaryDirectories.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    writeFileSync(first, "before-a", { mode: 0o600 });
    writeFileSync(second, "before-b", { mode: 0o600 });
    const snapshots = snapshotOpencodeGoFiles([first, second]);

    writeFileSync(first, "after-a", { mode: 0o600 });
    const guards = refreshOpencodeGoFileSnapshot(snapshots, first);
    await expect(assertOpencodeGoFileSnapshots(guards)).resolves.toBeUndefined();

    writeFileSync(second, "external-b", { mode: 0o600 });
    await expect(assertOpencodeGoFileSnapshots(guards))
      .rejects.toThrow(`OpenCode Go 配置文件在事务期间发生变化：${second}`);
  });
});

function previewEnvironment() {
  return {
    CODEX_HOME: "/tmp/codexc-opencode-go-provisioning-preview/codex",
    CODEX_CONNECT_HOME: "/tmp/codexc-opencode-go-provisioning-preview/connect",
  };
}
