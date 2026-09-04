import { describe, expect, it } from "vitest";

// @ts-expect-error JavaScript management helper intentionally has no declaration file.
import { assertManagedSetting, codexManagementError, isHighRiskManagementPath, ManagementOperationError } from "../scripts/webui-management-operations.mjs";
// @ts-expect-error JavaScript Provider settings helper intentionally has no declaration file.
import { redactProviderSettingsResult } from "../scripts/webui-provider-settings-management.mjs";
// @ts-expect-error JavaScript HTTP helper intentionally has no declaration file.
import { authorized, isLoopbackAddress } from "../scripts/webui-http.mjs";

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
