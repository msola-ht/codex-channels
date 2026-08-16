import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuOAuthController,
} from "../src/surfaces/feishu/oauth.js";
import type {
  FeishuCardDocument,
} from "../src/surfaces/feishu/approval-card.js";
import {
  renderFeishuOAuthCard,
} from "../src/surfaces/feishu/oauth-card.js";
import type {
  FeishuOAuthApi,
} from "../src/surfaces/feishu/oauth-device-flow.js";
import {
  FeishuOAuthRefreshError,
} from "../src/surfaces/feishu/oauth-device-flow.js";
import {
  EncryptedFileFeishuUserTokenStore,
  feishuTokenStatus,
  MacKeychainFeishuUserTokenStore,
  type FeishuUserTokenStore,
  type StoredFeishuUserToken,
} from "../src/surfaces/feishu/oauth-token-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Feishu OAuth controller", () => {
  it("does not pre-authorize app scopes without a capability request", async () => {
    const fixture = createController({
      listScopes: async () => [
        "drive:file:download",
        "task:task:read",
      ],
    });

    fixture.controller.beginAuthorization("oc_chat", "ou_actor", []);
    await vi.waitFor(() => {
      expect(fixture.deliverText).toHaveBeenCalledWith(
        "oc_chat",
        "当前没有需要用户授权的飞书能力；使用相关功能时会按需申请。",
      );
    });

    expect(fixture.api.listGrantedUserScopes).not.toHaveBeenCalled();
    expect(fixture.api.requestDeviceAuthorization).not.toHaveBeenCalled();
    expect(fixture.deliverCard).not.toHaveBeenCalled();
  });

  it("requests only the scopes required by the current capability", async () => {
    const fixture = createController({
      listScopes: async () => [
        "drive:file:download",
        "task:task:read",
        "calendar:calendar.event:read",
      ],
    });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["task:task:read"],
    );
    await fixture.finished();

    expect(fixture.api.requestDeviceAuthorization).toHaveBeenCalledWith(
      ["task:task:read"],
      expect.any(AbortSignal),
    );
  });

  it("does not start OAuth before the app has the required user scope", async () => {
    const fixture = createController({
      listScopes: async () => ["drive:file:download"],
    });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["task:task:read"],
    );
    await vi.waitFor(() => {
      expect(fixture.deliverMarkdown).toHaveBeenCalledWith(
        "oc_chat",
        expect.stringContaining("task:task:read"),
      );
    });

    expect(fixture.api.requestDeviceAuthorization).not.toHaveBeenCalled();
    expect(fixture.deliverCard).not.toHaveBeenCalled();
  });

  it("sends an in-app authorization card, verifies identity, and stores the token", async () => {
    const fixture = createController();

    expect(fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    )).toBe("started");
    await fixture.finished();

    expect(fixture.deliverCard).toHaveBeenCalledOnce();
    const card = fixture.deliverCard.mock.calls[0]?.[1];
    expect(JSON.stringify(card)).toContain(
      "https://applink.feishu.cn/client/web_url/open",
    );
    expect(JSON.stringify(card)).toContain("offline_access");
    expect(JSON.stringify(card)).not.toContain("access-secret");
    expect(fixture.api.readAuthorizedUser).toHaveBeenCalledWith(
      "access-secret",
      expect.any(AbortSignal),
    );
    expect(fixture.tokens.value).toMatchObject({
      appId: "cli_0123456789abcdef",
      userOpenId: "ou_actor",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      scopes: ["drive:file:download"],
    });
    expect(JSON.stringify(
      fixture.updateCard.mock.calls[0]?.[2],
    )).toContain("授权成功");
  });

  it("rejects an authorization completed by another Feishu user", async () => {
    const fixture = createController({
      authorizedUser: "ou_other",
    });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await fixture.finished();

    expect(fixture.tokens.value).toBeNull();
    expect(JSON.stringify(
      fixture.updateCard.mock.calls[0]?.[2],
    )).toContain("账号与发起人不一致");
  });

  it("keeps a successfully stored token when only the result card update fails", async () => {
    const fixture = createController();
    fixture.updateCard.mockRejectedValueOnce(new Error("platform failed"));

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await vi.waitFor(() => {
      expect(fixture.deliverText).toHaveBeenCalledWith(
        "oc_chat",
        "飞书授权成功，凭据已安全保存，但结果卡片更新失败。",
      );
    });

    expect(fixture.tokens.value).toMatchObject({
      accessToken: "access-secret",
    });
    expect(fixture.deliverText).not.toHaveBeenCalledWith(
      "oc_chat",
      expect.stringContaining("凭据未保存"),
    );
  });

  it("restores the previous credential when token persistence fails after a partial commit", async () => {
    const previous = storedToken({ accessToken: "previous-access" });
    const tokens = new MemoryTokenStore();
    tokens.value = previous;
    tokens.set = vi.fn(async (token: StoredFeishuUserToken) => {
      tokens.value = token;
      if (token.accessToken === "access-secret") {
        throw new Error("partial commit");
      }
    });
    const fixture = createController({ tokens });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await vi.waitFor(() => {
      expect(fixture.deliverText).toHaveBeenCalledWith(
        "oc_chat",
        expect.stringContaining("凭据未保存"),
      );
    });

    expect(tokens.value).toEqual(previous);
    expect(tokens.set).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fixture.updateCard.mock.calls))
      .not.toContain("授权成功");
  });

  it("deduplicates an in-flight authorization and revokes only local credentials", async () => {
    let resolvePoll: ((value: {
      status: "denied";
    }) => void) | undefined;
    const poll = new Promise<{ status: "denied" }>((resolve) => {
      resolvePoll = resolve;
    });
    const fixture = createController({ poll });

    expect(fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    )).toBe("started");
    expect(fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    )).toBe("running");
    resolvePoll?.({ status: "denied" });
    await fixture.finished();

    fixture.tokens.value = storedToken();
    await expect(fixture.controller.revoke("ou_actor")).resolves.toBe(true);
    expect(fixture.tokens.value).toBeNull();
  });

  it("clears an unreadable local credential on explicit revoke", async () => {
    const tokens = new UnreadableTokenStore();
    const fixture = createController({ tokens });

    await expect(fixture.controller.revoke("ou_actor")).resolves.toBe(true);
    expect(tokens.removed).toBe(true);
  });

  it("does not repeat authorization when a valid token covers current app scopes", async () => {
    const tokens = new MemoryTokenStore();
    tokens.value = storedToken({
      expiresAt: Date.now() + 60 * 60_000,
      refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60_000,
    });
    const fixture = createController({ tokens });

    expect(fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    )).toBe("started");
    await vi.waitFor(() => {
      expect(fixture.deliverText).toHaveBeenCalledWith(
        "oc_chat",
        "当前飞书账号已具备此能力需要的权限，无需重复授权。",
      );
    });

    expect(fixture.api.requestDeviceAuthorization).not.toHaveBeenCalled();
    expect(fixture.deliverCard).not.toHaveBeenCalled();
  });

  it("requests only app scopes missing from a valid stored token", async () => {
    const tokens = new MemoryTokenStore();
    tokens.value = storedToken({
      expiresAt: Date.now() + 60 * 60_000,
      refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60_000,
    });
    const fixture = createController({
      tokens,
      listScopes: async () => [
        "drive:file:download",
        "task:task:read",
      ],
    });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download", "task:task:read"],
    );
    await fixture.finished();

    expect(fixture.api.requestDeviceAuthorization).toHaveBeenCalledWith(
      ["task:task:read"],
      expect.any(AbortSignal),
    );
  });

  it("refreshes a refreshable token during status and rotates stored credentials", async () => {
    const tokens = new MemoryTokenStore();
    tokens.value = storedToken({
      expiresAt: Date.now() - 1_000,
      refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60_000,
    });
    const fixture = createController({ tokens });

    await expect(fixture.controller.status("ou_actor"))
      .resolves.toBe("valid");
    expect(fixture.api.refreshUserToken).toHaveBeenCalledWith(
      "refresh-secret",
      expect.any(AbortSignal),
    );
    expect(tokens.value).toMatchObject({
      userOpenId: "ou_actor",
      accessToken: "access-refreshed",
      refreshToken: "refresh-rotated",
    });
    expect(tokens.value!.scopes).toEqual(["drive:file:download"]);
    expect(tokens.value!.grantedAt).toBe(1_000_000);
  });

  it("runs only one refresh at a time per user", async () => {
    const tokens = new MemoryTokenStore();
    tokens.value = storedToken({
      expiresAt: Date.now() - 1_000,
      refreshExpiresAt: Date.now() + 60_000,
    });
    const fixture = createController({ tokens });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.api.refreshUserToken.mockImplementation(async () => {
      await gate;
      return {
        accessToken: "access-refreshed",
        refreshToken: "refresh-rotated",
        expiresInSeconds: 7_200,
        refreshExpiresInSeconds: 604_800,
        openId: "ou_actor",
      };
    });

    const first = fixture.controller.status("ou_actor");
    const second = fixture.controller.status("ou_actor");
    release();
    await expect(Promise.all([first, second]))
      .resolves.toEqual(["valid", "valid"]);
    expect(fixture.api.refreshUserToken).toHaveBeenCalledTimes(1);
  });

  it("keeps the stored token and reports expired when refresh is terminally rejected", async () => {
    const tokens = new MemoryTokenStore();
    tokens.value = storedToken({
      expiresAt: Date.now() - 1_000,
      refreshExpiresAt: Date.now() + 60_000,
    });
    const fixture = createController({ tokens });
    fixture.api.refreshUserToken.mockRejectedValue(
      new FeishuOAuthRefreshError(20_037),
    );

    await expect(fixture.controller.status("ou_actor"))
      .resolves.toBe("expired");
    expect(tokens.value).not.toBeNull();
    expect(tokens.value!.accessToken).toBe("access-secret");
  });

  it("keeps a refreshable status when refresh fails without a terminal code", async () => {
    const tokens = new MemoryTokenStore();
    tokens.value = storedToken({
      expiresAt: Date.now() - 1_000,
      refreshExpiresAt: Date.now() + 60_000,
    });
    const fixture = createController({ tokens });
    fixture.api.refreshUserToken.mockRejectedValue(new Error("network"));

    await expect(fixture.controller.status("ou_actor"))
      .resolves.toBe("refreshable");
    expect(tokens.value!.accessToken).toBe("access-secret");
  });

  it("rejects a refreshed token whose identity does not match the stored actor", async () => {
    const tokens = new MemoryTokenStore();
    tokens.value = storedToken({
      expiresAt: Date.now() - 1_000,
      refreshExpiresAt: Date.now() + 60_000,
    });
    const fixture = createController({ tokens });
    fixture.api.refreshUserToken.mockResolvedValue({
      accessToken: "access-refreshed",
      refreshToken: "refresh-rotated",
      expiresInSeconds: 7_200,
      refreshExpiresInSeconds: 604_800,
      openId: "ou_other",
    });

    await expect(fixture.controller.status("ou_actor"))
      .resolves.toBe("expired");
    expect(tokens.value!.accessToken).toBe("access-secret");
  });

  it("refreshes before deciding that authorization is already covered", async () => {
    const tokens = new MemoryTokenStore();
    tokens.value = storedToken({
      expiresAt: Date.now() - 1_000,
      refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60_000,
    });
    const fixture = createController({ tokens });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await vi.waitFor(() => {
      expect(fixture.deliverText).toHaveBeenCalledWith(
        "oc_chat",
        "当前飞书账号已具备此能力需要的权限，无需重复授权。",
      );
    });

    expect(fixture.api.refreshUserToken).toHaveBeenCalled();
    expect(fixture.api.requestDeviceAuthorization).not.toHaveBeenCalled();
  });

  it("reports an authorization that is currently in progress", async () => {
    const fixture = createController({
      poll: (_authorization, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve({ status: "expired" });
        }, { once: true });
      }),
    });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );

    await expect(fixture.controller.status("ou_actor"))
      .resolves.toBe("pending");
    await fixture.controller.close();
  });

  it("cancels pending polling during close", async () => {
    let observedSignal: AbortSignal | undefined;
    const fixture = createController({
      poll: (_authorization, signal) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ status: "expired" });
          }, { once: true });
        });
      },
    });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await vi.waitFor(() => {
      expect(observedSignal).toBeDefined();
    });
    await fixture.controller.close();

    expect(observedSignal?.aborted).toBe(true);
    expect(fixture.tokens.value).toBeNull();
  });

  it("cancels application scope discovery during close", async () => {
    let observedSignal: AbortSignal | undefined;
    const fixture = createController({
      listScopes: (signal) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve([]), {
            once: true,
          });
        });
      },
    });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await vi.waitFor(() => {
      expect(observedSignal).toBeDefined();
    });
    await fixture.controller.close();

    expect(observedSignal?.aborted).toBe(true);
    expect(fixture.deliverCard).not.toHaveBeenCalled();
    expect(fixture.deliverText).not.toHaveBeenCalled();
  });

  it("bounds close when an upstream authorization operation ignores cancellation", async () => {
    const fixture = createController({
      listScopes: () => new Promise(() => {}),
      closeTimeoutMs: 10,
    });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await vi.waitFor(() => {
      expect(fixture.api.listGrantedUserScopes).toHaveBeenCalledOnce();
    });

    await expect(fixture.controller.close()).resolves.toBeUndefined();
  });

  it("restores the previous credential when close races with token persistence", async () => {
    const previous = storedToken({ accessToken: "previous-access" });
    let releaseSet: (() => void) | undefined;
    const setStarted = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    let allowSetToFinish: (() => void) | undefined;
    const setGate = new Promise<void>((resolve) => {
      allowSetToFinish = resolve;
    });
    const tokens = new MemoryTokenStore();
    tokens.value = previous;
    tokens.set = vi.fn(async (token: StoredFeishuUserToken) => {
      releaseSet?.();
      await setGate;
      tokens.value = token;
    });
    const fixture = createController({ tokens });

    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await setStarted;
    const closing = fixture.controller.close();
    allowSetToFinish?.();
    await closing;

    expect(tokens.value).toEqual(previous);
    expect(JSON.stringify(fixture.updateCard.mock.calls))
      .not.toContain("授权成功");
  });

  it("cancels pending polling before revoking so a late result cannot restore the token", async () => {
    let resolvePoll: ((value: {
      status: "authorized";
      token: {
        accessToken: string;
        refreshToken: string;
        expiresInSeconds: number;
        refreshExpiresInSeconds: number;
        scopes: string[];
      };
    }) => void) | undefined;
    const fixture = createController({
      poll: () => new Promise((resolve) => {
        resolvePoll = resolve;
      }),
    });
    fixture.controller.beginAuthorization(
      "oc_chat",
      "ou_actor",
      ["drive:file:download"],
    );
    await vi.waitFor(() => {
      expect(resolvePoll).toBeDefined();
    });

    const revoking = fixture.controller.revoke("ou_actor");
    resolvePoll?.({
      status: "authorized",
      token: {
        accessToken: "late-access",
        refreshToken: "late-refresh",
        expiresInSeconds: 7_200,
        refreshExpiresInSeconds: 604_800,
        scopes: ["drive:file:download"],
      },
    });

    await expect(revoking).resolves.toBe(false);
    expect(fixture.tokens.value).toBeNull();
    expect(fixture.api.readAuthorizedUser).not.toHaveBeenCalled();
    expect(fixture.deliverText).not.toHaveBeenCalled();
  });
});

describe("Feishu OAuth card", () => {
  it("opens the device flow inside Feishu instead of exposing a plain external link", () => {
    const card = renderFeishuOAuthCard(
      "https://accounts.feishu.cn/device?code=abc",
      ["drive:file:download"],
      240,
    );
    const serialized = JSON.stringify(card);

    expect(serialized).toContain(
      "https://applink.feishu.cn/client/web_url/open",
    );
    expect(serialized).toContain("在飞书内授权");
    expect(serialized).not.toContain("app-secret");
  });

  it("refuses to wrap an authorization URL outside Feishu accounts", () => {
    expect(() => renderFeishuOAuthCard(
      "https://example.com/device?code=abc",
      ["drive:file:download", "offline_access"],
      240,
    )).toThrow("飞书 OAuth 授权地址无效");
  });

  it("refuses a nondefault port on the Feishu accounts host", () => {
    expect(() => renderFeishuOAuthCard(
      "https://accounts.feishu.cn:8443/device?code=abc",
      ["drive:file:download", "offline_access"],
      240,
    )).toThrow("飞书 OAuth 授权地址无效");
  });
});

describe("Feishu encrypted token store", () => {
  it("persists no plaintext token and enforces private permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-feishu-token-"));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o755);
    const store = new EncryptedFileFeishuUserTokenStore(directory);
    const token = storedToken();

    await store.set(token);

    const files = readdirSync(directory);
    expect(files).toHaveLength(2);
    expect(files).toContain(
      `${createHash("sha256")
        .update(`${token.appId}:${token.userOpenId}`)
        .digest("hex")}.enc`,
    );
    for (const file of files) {
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(directory, file)).includes(
        Buffer.from("access-secret"),
      )).toBe(false);
    }
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    await expect(store.get(token.appId, token.userOpenId))
      .resolves.toEqual(token);
    await store.remove(token.appId, token.userOpenId);
    await expect(store.get(token.appId, token.userOpenId))
      .resolves.toBeNull();
  });

  it("round-trips a granted scope list beyond one hundred entries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-feishu-token-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedFileFeishuUserTokenStore(directory);
    const token = storedToken({
      scopes: [
        ...Array.from({ length: 137 }, (_, index) => `scope:${index}`),
        "offline_access",
      ],
    });

    await store.set(token);

    await expect(store.get(token.appId, token.userOpenId))
      .resolves.toEqual(token);
  });

  it("does not treat a corrupted encrypted credential as missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-feishu-token-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedFileFeishuUserTokenStore(directory);
    const token = storedToken();
    await store.set(token);
    const credential = readdirSync(directory).find((file) =>
      file.endsWith(".enc")
    );
    if (!credential) {
      throw new Error("expected encrypted credential");
    }
    writeFileSync(join(directory, credential), "corrupted", { mode: 0o600 });

    await expect(store.get(token.appId, token.userOpenId))
      .rejects.toThrow("读取飞书加密凭据失败");
  });

  it("reports valid, refreshable, expired, and missing states without exposing tokens", () => {
    const now = 10_000_000;
    expect(feishuTokenStatus(null, now)).toBe("missing");
    expect(feishuTokenStatus(storedToken({
      expiresAt: now + 600_000,
      refreshExpiresAt: now + 1_000_000,
    }), now)).toBe("valid");
    expect(feishuTokenStatus(storedToken({
      expiresAt: now,
      refreshExpiresAt: now + 1_000_000,
    }), now)).toBe("refreshable");
    expect(feishuTokenStatus(storedToken({
      expiresAt: now,
      refreshExpiresAt: now,
    }), now)).toBe("expired");
  });
});

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

function createController({
  authorizedUser = "ou_actor",
  poll,
  listScopes,
  tokens = new MemoryTokenStore(),
  closeTimeoutMs,
}: {
  authorizedUser?: string;
  listScopes?: (signal: AbortSignal) => Promise<readonly string[]>;
  tokens?: MemoryTokenStore;
  closeTimeoutMs?: number;
  poll?:
    | Promise<{ status: "denied" }>
    | ((
      authorization: {
        deviceCode: string;
        verificationUriComplete: string;
        expiresInSeconds: number;
        intervalSeconds: number;
      },
      signal: AbortSignal,
    ) => Promise<
      | { status: "expired" }
      | {
        status: "authorized";
        token: {
          accessToken: string;
          refreshToken: string;
          expiresInSeconds: number;
          refreshExpiresInSeconds: number;
          scopes: string[];
        };
      }
    >);
} = {}) {
  const deliverCard = vi.fn<
    (chatId: string, card: FeishuCardDocument) => Promise<string>
  >(async () => "om_auth_card");
  const updateCard = vi.fn<
    (
      chatId: string,
      messageId: string,
      card: FeishuCardDocument,
    ) => Promise<void>
  >(async () => {});
  const deliverText = vi.fn<
    (chatId: string, text: string) => Promise<void>
  >(async () => {});
  const deliverMarkdown = vi.fn<
    (chatId: string, markdown: string) => Promise<void>
  >(async () => {});
  const readAuthorizedUser = vi.fn(async () => authorizedUser);
  const listGrantedUserScopes = vi.fn(
    listScopes ?? (async () => ["drive:file:download"]),
  );
  const refreshUserToken = vi.fn(async () => ({
    accessToken: "access-refreshed",
    refreshToken: "refresh-rotated",
    expiresInSeconds: 7_200,
    refreshExpiresInSeconds: 604_800,
    openId: "ou_actor",
  }));
  const api: FeishuOAuthApi = {
    listGrantedUserScopes,
    requestDeviceAuthorization: vi.fn(async () => ({
      deviceCode: "device-secret",
      verificationUriComplete:
        "https://accounts.feishu.cn/device?code=verification",
      expiresInSeconds: 240,
      intervalSeconds: 5,
      scopes: ["drive:file:download", "offline_access"],
    })),
    pollDeviceToken: vi.fn(
      poll instanceof Promise
        ? async () => poll
        : poll ?? (async () => ({
          status: "authorized" as const,
          token: {
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
            expiresInSeconds: 7_200,
            refreshExpiresInSeconds: 604_800,
            scopes: ["drive:file:download"],
          },
      })),
    ),
    refreshUserToken,
    readAuthorizedUser,
  };
  const controller = new FeishuOAuthController(
    "cli_0123456789abcdef",
    api,
    tokens,
    {
      deliverCard,
      updateCard,
      deliverText,
      deliverMarkdown,
    },
    pino({ level: "silent" }),
    closeTimeoutMs,
  );
  return {
    controller,
    api: {
      readAuthorizedUser,
      listGrantedUserScopes,
      requestDeviceAuthorization: api.requestDeviceAuthorization,
      refreshUserToken,
    },
    tokens,
    deliverCard,
    updateCard,
    deliverText,
    deliverMarkdown,
    async finished() {
      await vi.waitFor(() => {
        expect(
          updateCard.mock.calls.length + deliverText.mock.calls.length,
        ).toBeGreaterThan(0);
      });
    },
  };
}

class MemoryTokenStore implements FeishuUserTokenStore {
  value: StoredFeishuUserToken | null = null;

  async get(): Promise<StoredFeishuUserToken | null> {
    return this.value;
  }

  async set(token: StoredFeishuUserToken): Promise<void> {
    this.value = token;
  }

  async remove(): Promise<void> {
    this.value = null;
  }
}

class UnreadableTokenStore extends MemoryTokenStore {
  removed = false;

  override async get(): Promise<StoredFeishuUserToken | null> {
    throw new Error("读取飞书加密凭据失败");
  }

  override async remove(): Promise<void> {
    this.removed = true;
  }
}

function storedToken(
  overrides: Partial<StoredFeishuUserToken> = {},
): StoredFeishuUserToken {
  return {
    appId: "cli_0123456789abcdef",
    userOpenId: "ou_actor",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: 20_000_000,
    refreshExpiresAt: 30_000_000,
    scopes: ["drive:file:download"],
    grantedAt: 1_000_000,
    ...overrides,
  };
}
