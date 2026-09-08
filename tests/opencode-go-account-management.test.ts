import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OpenCodeGoAccountManagementError,
  applyOpencodeGoAccountRemoval,
  applyOpencodeGoAccountStop,
  applyOpencodeGoDefaultAccountChange,
  previewOpencodeGoAccountRemoval,
  previewOpencodeGoAccountStop,
  previewOpencodeGoDefaultAccountChange,
} from "../scripts/opencode-go-account-management.mjs";

const accounts = [
  { id: "main", default: true, email: "user@example.com" },
  { id: "b", default: false },
];

describe("OpenCode Go account management", () => {
  it("previews a default-account change without prompts or credentials", () => {
    const preview = previewOpencodeGoDefaultAccountChange("b", {
      environment: {},
      loadAccounts: () => accounts,
    });

    expect(preview).toEqual({
      operation: "set-default",
      account: { id: "b", default: true },
      currentDefaultAccountId: "main",
      updatesExternalAgent: false,
      willChange: true,
      activation: "restart-all",
    });
    expect(JSON.stringify(preview)).not.toContain("apiKey");
  });

  it("applies a default-account change without touching the shared agent", async () => {
    const writeAccounts = vi.fn();

    const result = await applyOpencodeGoDefaultAccountChange("b", {
      environment: {},
      loadAccounts: () => accounts,
      writeAccounts,
    });

    expect(result).toMatchObject({
      action: "default-set",
      account: { id: "b", default: true },
      activation: "restart-all",
    });
    expect(writeAccounts).toHaveBeenCalledWith({}, [
      { id: "main", default: false, email: "user@example.com" },
      { id: "b", default: true },
    ]);
  });

  it("returns a stable field error for an unknown account", () => {
    try {
      previewOpencodeGoDefaultAccountChange("missing", {
        environment: {},
        loadAccounts: () => accounts,
      });
      throw new Error("expected unknown account validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeGoAccountManagementError);
      expect(error).toMatchObject({ code: "account-not-found", field: "accountId" });
    }
  });

  it("normalizes an unreadable account registry into a stable state error", () => {
    expect(() => previewOpencodeGoDefaultAccountChange("b", {
      environment: {},
      loadAccounts: () => { throw new Error("private registry rejected"); },
    })).toThrowError(expect.objectContaining({
      code: "account-state-unavailable",
      field: "accountId",
      message: "private registry rejected",
    }));
  });

  it("previews a running account and reports a held lease after execution", async () => {
    const options = {
      environment: {},
      loadAccounts: () => accounts,
      resolvePrimarySocket: () => "/tmp/app-server.sock",
      inspectSupervisor: async () => ({
        status: "ready" as const,
        topology: {
          version: 4 as const,
          pid: 123,
          primaryProvider: "openai",
          managedProviders: ["ocg-main", "ocg-b"],
          socketPaths: ["/tmp/app-server.sock"],
          runningProviders: ["ocg-b"],
          releasedProviders: [],
          leasedProviders: ["ocg-b"],
        },
      }),
    };

    await expect(previewOpencodeGoAccountStop("b", options)).resolves.toEqual({
      operation: "stop",
      account: { id: "b", provider: "ocg-b" },
      status: "running",
      willChange: true,
      activation: "none",
    });

    await expect(applyOpencodeGoAccountStop("b", {
      ...options,
      releaseProvider: async () => ({ released: false, reason: "leased" }),
    })).resolves.toEqual({
      action: "in-use",
      operation: "stop",
      account: { id: "b", provider: "ocg-b" },
      status: "in-use",
      willChange: false,
      activation: "none",
    });
  });

  it("does not release an account whose App Server is not running", async () => {
    const releaseProvider = vi.fn();
    const result = await applyOpencodeGoAccountStop("b", {
      environment: {},
      loadAccounts: () => accounts,
      resolvePrimarySocket: () => "/tmp/app-server.sock",
      inspectSupervisor: async () => ({ status: "missing" as const }),
      releaseProvider,
    });

    expect(result).toEqual({
      action: "not-running",
      operation: "stop",
      account: { id: "b", provider: "ocg-b" },
      status: "not-running",
      willChange: false,
      activation: "none",
    });
    expect(releaseProvider).not.toHaveBeenCalled();
  });

  it("previews account removal without exposing credentials", async () => {
    const preview = await previewOpencodeGoAccountRemoval("main", {
      environment: {},
      loadAccounts: () => accounts,
      loadRole: () => undefined,
      resolvePrimarySocket: () => "/tmp/app-server.sock",
      inspectSupervisor: async () => ({ status: "missing" as const }),
    });

    expect(preview).toEqual({
      operation: "remove",
      account: {
        id: "main",
        provider: "ocg-main",
        email: "user@example.com",
        default: true,
      },
      effects: {
        stopsRunningAppServer: false,
        promotesDefaultAccountId: "b",
        preservesPrivateBackup: true,
        historyThreadsBecomeUnavailable: true,
      },
      confirmation: { required: true, field: "confirmHistoryLoss" },
      activation: "restart-all",
    });
    expect(JSON.stringify(preview)).not.toContain("apiKey");
  });

  it("previews removal of the final switching account without restoring main config", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-ocg-management-"));
    const markerPath = join(
      home,
      ".codex-connect",
      "providers",
      "opencode-go",
      "accounts",
      "main",
      "managed.toml",
    );
    mkdirSync(join(markerPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(
      markerPath,
      'version = 1\nprovider = "ocg-main"\nmode = "switching"\n',
      { mode: 0o600 },
    );
    try {
      const preview = await previewOpencodeGoAccountRemoval("main", {
        environment: {
          CODEX_HOME: join(home, ".codex"),
          CODEX_CONNECT_HOME: join(home, ".codex-connect"),
        },
        loadAccounts: () => [{ id: "main", default: true, email: "user@example.com" }],
        loadRole: () => undefined,
        resolvePrimarySocket: () => "/tmp/app-server.sock",
        inspectSupervisor: async () => ({ status: "missing" as const }),
      });

      expect(preview).toEqual({
        operation: "remove",
        account: {
          id: "main",
          provider: "ocg-main",
          email: "user@example.com",
          default: true,
        },
        effects: {
          stopsRunningAppServer: false,
          promotesDefaultAccountId: null,
          preservesPrivateBackup: true,
          historyThreadsBecomeUnavailable: true,
          removesLastAccount: true,
          removesManagedCatalog: true,
        },
        confirmation: { required: true, field: "confirmHistoryLoss" },
        activation: "restart-all",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("requires an explicit history-loss confirmation before account removal", async () => {
    await expect(applyOpencodeGoAccountRemoval({ accountId: "b" }, {
      environment: {},
      loadAccounts: () => accounts,
      loadRole: () => undefined,
      resolvePrimarySocket: () => "/tmp/app-server.sock",
      inspectSupervisor: async () => ({ status: "missing" as const }),
    })).rejects.toMatchObject({
      code: "confirmation-required",
      field: "confirmHistoryLoss",
    });
  });

  it("rejects removal when the account runtime is held by another client", async () => {
    await expect(applyOpencodeGoAccountRemoval({
      accountId: "b",
      confirmHistoryLoss: true,
    }, {
      environment: {},
      loadAccounts: () => accounts,
      loadRole: () => undefined,
      resolvePrimarySocket: () => "/tmp/app-server.sock",
      inspectSupervisor: async () => ({ status: "missing" as const }),
      stopAccount: async () => ({ action: "in-use" as const }),
    })).rejects.toMatchObject({
      code: "account-runtime-in-use",
      field: "accountId",
    });
  });
});
