import { describe, expect, it, vi } from "vitest";

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
      loadRole: () => ({
        provider: "ocg-main" as const,
        model: "deepseek-v4-flash-vision-exp",
      }),
    });

    expect(preview).toEqual({
      operation: "set-default",
      account: { id: "b", default: true },
      currentDefaultAccountId: "main",
      updatesExternalAgent: true,
      willChange: true,
      activation: "restart-all",
    });
    expect(JSON.stringify(preview)).not.toContain("apiKey");
  });

  it("applies a default-account change and updates the shared agent", async () => {
    const writeAccounts = vi.fn();
    const configureRole = vi.fn(async () => undefined);

    const result = await applyOpencodeGoDefaultAccountChange("b", {
      environment: {},
      loadAccounts: () => accounts,
      loadRole: () => ({
        provider: "ocg-main" as const,
        model: "deepseek-v4-flash-vision-exp",
      }),
      loadProviders: () => [{
        provider: "ocg-b",
        displayName: "OpenCode Go (b)",
        model: "deepseek-v4-pro",
        reasoningEffort: "medium",
        mode: "switching",
        models: [],
      }],
      writeAccounts,
      configureRole,
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
    expect(configureRole).toHaveBeenCalledWith(
      "ocg-b",
      "deepseek-v4-pro",
      {},
    );
  });

  it("returns a stable field error for an unknown account", () => {
    try {
      previewOpencodeGoDefaultAccountChange("missing", {
        environment: {},
        loadAccounts: () => accounts,
        loadRole: () => undefined,
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
      loadRole: () => undefined,
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
