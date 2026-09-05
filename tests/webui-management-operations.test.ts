import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript management helper intentionally has no declaration file.
import { assertManagedSetting, codexManagementError, isHighRiskManagementPath, ManagementOperationError } from "../scripts/webui-management-operations.mjs";
// @ts-expect-error JavaScript Provider settings helper intentionally has no declaration file.
import { redactProviderSettingsResult } from "../scripts/webui-provider-settings-management.mjs";
// @ts-expect-error JavaScript account settings helper intentionally has no declaration file.
import { accountSettingsApplyInput, loadAccountSettingsResource, normalizeAccountSettingsMutation, redactAccountSettingsResult } from "../scripts/webui-account-settings-management.mjs";
import { writeOpencodeGoAccountMarker, writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
// @ts-expect-error JavaScript HTTP helper intentionally has no declaration file.
import { authorized, isLoopbackAddress } from "../scripts/webui-http.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WebUI management operation boundaries", () => {
  it("uses transport-neutral errors for management validation", () => {
    expect(() => assertManagedSetting({ kind: "display.reasoning" })).not.toThrow();
    expect(() => assertManagedSetting({ kind: "unsupported.setting" })).toThrow(ManagementOperationError);

    const error = codexManagementError(Object.assign(new Error("stale"), {
      code: "stale-revision",
      field: "revision",
    }));
    expect(error).toBeInstanceOf(ManagementOperationError);
    expect(error).toMatchObject({ code: "stale-revision", field: "revision" });
  });

  it("keeps high-risk path classification explicit", () => {
    expect(isHighRiskManagementPath("/api-providers")).toBe(true);
    expect(isHighRiskManagementPath("/provider-settings/preview")).toBe(true);
    expect(isHighRiskManagementPath("/account-settings/preview")).toBe(true);
    expect(isHighRiskManagementPath("/tasks/preview")).toBe(true);
    expect(isHighRiskManagementPath("/settings")).toBe(false);
  });

  it("redacts Provider credentials from preview and result projections", () => {
    const value = redactProviderSettingsResult({
      operation: "create",
      provider: { id: "relay", displayName: "Relay" },
      credential: { action: "replace", apiKey: "secret-key", storedAsPlaintext: true, destination: "private-profile" },
    });
    expect(value).toMatchObject({
      operation: "create",
      credential: { action: "replace", storedAsPlaintext: true, destination: "private-profile" },
    });
    expect(JSON.stringify(value)).not.toContain("secret-key");
  });

  it("normalizes account settings and redacts account credentials", () => {
    const input = normalizeAccountSettingsMutation({
      operation: "opencode.account.configure",
      accountId: "main",
      contact: "main@example.com",
      apiKey: "secret-key",
    });
    expect(input).toMatchObject({ operation: "opencode.account.configure", accountId: "main" });
    const value = redactAccountSettingsResult({
      operation: "opencode.account.configure",
      account: { id: "main", displayName: "ocg-main", apiKey: "secret-key" },
      activation: "restart-all",
    });
    expect(value).toMatchObject({ operation: "opencode.account.configure", account: { id: "main" } });
    expect(JSON.stringify(value)).not.toContain("secret-key");
  });

  it("projects the persisted OpenCode Go account mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-webui-account-resource-"));
    temporaryDirectories.push(home);
    const environment = {
      ...process.env,
      CODEX_HOME: join(home, ".codex"),
      CODEX_CONNECT_HOME: join(home, ".codex-connect"),
    };
    writeOpencodeGoAccounts(environment, [{ id: "main", default: true, email: "main@example.com" }]);
    writeOpencodeGoAccountMarker(environment, "main", "exclusive");

    const resource = await loadAccountSettingsResource(environment, undefined, () => []);
    expect(resource.opencodeGo.accounts[0]).toMatchObject({ id: "main", mode: "exclusive" });
  });

  it("adds only the confirmation fields required by the underlying account operations", () => {
    expect(accountSettingsApplyInput({ operation: "opencode.account.configure", mode: "exclusive", apiKey: "secret" }))
      .toMatchObject({ confirmExclusiveConfigChange: true });
    expect(accountSettingsApplyInput({ operation: "opencode.account.remove", accountId: "main" }))
      .toMatchObject({ confirmHistoryLoss: true });
    expect(accountSettingsApplyInput({ operation: "deepseek.configure", mode: "exclusive", apiKey: "secret" }))
      .toMatchObject({ confirmExclusiveConfigChange: true });
    expect(accountSettingsApplyInput({ operation: "deepseek.restore" }))
      .toMatchObject({ confirmRestore: true });
  });

  it("accepts only loopback management clients and matching bearer tokens", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.0.2.1")).toBe(false);

    const request = (authorization?: string) => ({ headers: { authorization } });
    expect(authorized(request("Bearer secret"), "secret")).toBe(true);
    expect(authorized(request("Bearer wrong"), "secret")).toBe(false);
    expect(authorized(request(), "secret")).toBe(false);
  });
});
