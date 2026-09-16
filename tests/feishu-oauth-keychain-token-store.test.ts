import { describe, expect, it, vi } from "vitest";

import { MacKeychainFeishuUserTokenStore } from "../src/surfaces/feishu/oauth-token-store.js";
import { storedFeishuToken as storedToken } from "./feishu-oauth-test-fixture.js";

describe("Feishu macOS Keychain token store", () => {
  it("uses a scoped generic-password entry and round-trips only the requested actor", async () => {
    const token = storedToken();
    const run = vi.fn(async (
      _file: string,
      arguments_: readonly string[],
    ) => ({
      stdout: arguments_[0] === "find-generic-password"
        ? JSON.stringify(token)
        : "",
    }));
    const store = new MacKeychainFeishuUserTokenStore(run);

    await expect(store.get(token.appId, token.userOpenId))
      .resolves.toEqual(token);
    await store.set(token);
    await store.remove(token.appId, token.userOpenId);

    expect(run.mock.calls.every(([file]) => file === "security")).toBe(true);
    expect(run.mock.calls[0]?.[1]).toEqual([
      "find-generic-password",
      "-s",
      "codexc-feishu-uat",
      "-a",
      "cli_0123456789abcdef:ou_actor",
      "-w",
    ]);
    expect(run.mock.calls[1]?.[1]).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "codexc-feishu-uat",
      "-a",
      "cli_0123456789abcdef:ou_actor",
      "-w",
      JSON.stringify(token),
    ]);
    expect(run.mock.calls.filter(([, arguments_]) =>
      arguments_[0] === "delete-generic-password"
    )).toHaveLength(1);
    expect(run.mock.calls[2]?.[1]?.[0]).toBe("delete-generic-password");
  });

  it("rejects malformed stored credentials instead of treating them as authorized", async () => {
    const invalidToken = {
      ...storedToken(),
      accessToken: "",
      expiresAt: -1,
      scopes: ["drive:file:download", "invalid scope"],
    };
    const store = new MacKeychainFeishuUserTokenStore(
      vi.fn(async () => ({
        stdout: JSON.stringify(invalidToken),
      })),
    );

    await expect(store.get(
      "cli_0123456789abcdef",
      "ou_actor",
    )).resolves.toBeNull();
  });

  it("does not treat a Keychain read failure as a missing credential", async () => {
    const failure = Object.assign(new Error("Keychain unavailable"), {
      code: 1,
    });
    const store = new MacKeychainFeishuUserTokenStore(
      vi.fn(async () => {
        throw failure;
      }),
    );

    await expect(store.get(
      "cli_0123456789abcdef",
      "ou_actor",
    )).rejects.toBe(failure);
  });

  it("does not report a successful revoke when Keychain deletion fails", async () => {
    const failure = Object.assign(new Error("Keychain unavailable"), {
      code: 1,
    });
    const store = new MacKeychainFeishuUserTokenStore(
      vi.fn(async () => {
        throw failure;
      }),
    );

    await expect(store.remove(
      "cli_0123456789abcdef",
      "ou_actor",
    )).rejects.toBe(failure);
  });
});
