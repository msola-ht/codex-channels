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

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EncryptedFileWeixinCredentialStore,
  MacKeychainWeixinCredentialStore,
  type StoredWeixinCredential,
} from "../src/surfaces/weixin/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Weixin credential store", () => {
  it("uses an isolated encrypted directory without plaintext credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-weixin-token-"));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o755);
    const store = new EncryptedFileWeixinCredentialStore(directory);
    const credential = storedCredential();

    await store.set(credential);

    const files = readdirSync(directory);
    expect(files).toHaveLength(2);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of files) {
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(directory, file)).includes(
        Buffer.from(credential.botToken),
      )).toBe(false);
    }
    await expect(store.get(credential.accountId)).resolves.toEqual(credential);
    await store.remove(credential.accountId);
    await expect(store.get(credential.accountId)).resolves.toBeNull();
  });

  it("fails closed on corrupted or mismatched payloads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-weixin-token-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedFileWeixinCredentialStore(directory);
    const credential = storedCredential();
    await store.set(credential);
    const encrypted = readdirSync(directory).find((name) => name.endsWith(".enc"));
    expect(encrypted).toBeDefined();
    writeFileSync(join(directory, encrypted!), "corrupted", { mode: 0o600 });

    await expect(store.get(credential.accountId))
      .rejects.toThrow("读取微信加密凭据失败");
    await expect(store.set({
      ...credential,
      version: 2 as 1,
    })).rejects.toThrow("微信凭据载荷无效");
  });

  it("uses a separate macOS Keychain service and exact account key", async () => {
    const credential = storedCredential();
    const run = vi.fn(async (
      _file: string,
      arguments_: readonly string[],
    ) => ({
      stdout: arguments_[0] === "find-generic-password"
        ? JSON.stringify(credential)
        : "",
    }));
    const store = new MacKeychainWeixinCredentialStore(run);

    await expect(store.get(credential.accountId)).resolves.toEqual(credential);
    await store.set(credential);
    await store.remove(credential.accountId);

    expect(run.mock.calls[0]?.[1]).toEqual([
      "find-generic-password",
      "-s",
      "codexc-weixin-bot-token",
      "-a",
      credential.accountId,
      "-w",
    ]);
    expect(run.mock.calls[1]?.[1]).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "codexc-weixin-bot-token",
      "-a",
      credential.accountId,
      "-w",
      JSON.stringify(credential),
    ]);
  });
});

function storedCredential(
  overrides: Partial<StoredWeixinCredential> = {},
): StoredWeixinCredential {
  return {
    version: 1,
    accountId: "bot-fixture@im.bot",
    botToken: "bot-secret",
    baseUrl: "https://ilinkai.weixin.qq.com",
    grantedAt: 1_000,
    ...overrides,
  };
}
