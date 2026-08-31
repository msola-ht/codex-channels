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
  EncryptedFileWeixinReplyContextPersistence,
  MacKeychainWeixinReplyContextPersistence,
} from "../src/surfaces/weixin/index.js";

const temporaryDirectories: string[] = [];
const target = {
  surface: "weixin",
  accountId: "bot-fixture@im.bot",
  conversationId: "actor-fixture@im.wechat",
} as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Weixin reply context persistence", () => {
  it("stores one private reply context in an isolated encrypted directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-weixin-context-"));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o755);
    const store = new EncryptedFileWeixinReplyContextPersistence(
      directory,
      () => 1_000,
    );

    await store.set(target, target.conversationId, "context-secret");

    const files = readdirSync(directory);
    expect(files).toHaveLength(2);
    if (process.platform !== "win32") expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of files) {
      if (process.platform !== "win32") expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(directory, file)).includes(
        Buffer.from("context-secret"),
      )).toBe(false);
    }
    await expect(store.get(target)).resolves.toEqual({
      version: 1,
      accountId: target.accountId,
      actorId: target.conversationId,
      contextToken: "context-secret",
      updatedAt: 1_000,
    });
    await store.remove(target);
    await expect(store.get(target)).resolves.toBeNull();
  });

  it("fails closed on corrupted or mismatched records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-weixin-context-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedFileWeixinReplyContextPersistence(directory);
    await store.set(target, target.conversationId, "context-secret");
    const encrypted = readdirSync(directory).find((name) => name.endsWith(".enc"));
    expect(encrypted).toBeDefined();
    writeFileSync(join(directory, encrypted!), "corrupted", { mode: 0o600 });

    await expect(store.get(target))
      .rejects.toThrow("读取微信加密回复上下文失败");
    await expect(store.set(
      target,
      "other-fixture@im.wechat",
      "context-secret",
    )).rejects.toThrow("微信回复上下文载荷无效");
  });

  it("uses a dedicated macOS Keychain service and exact target key", async () => {
    const record = {
      version: 1,
      accountId: target.accountId,
      actorId: target.conversationId,
      contextToken: "context-secret",
      updatedAt: 1_000,
    } as const;
    const run = vi.fn(async (
      _file: string,
      arguments_: readonly string[],
    ) => ({
      stdout: arguments_[0] === "find-generic-password"
        ? JSON.stringify(record)
        : "",
    }));
    const store = new MacKeychainWeixinReplyContextPersistence(
      run,
      () => 1_000,
    );
    const targetKey = JSON.stringify([
      target.accountId,
      target.conversationId,
    ]);

    await expect(store.get(target)).resolves.toEqual(record);
    await store.set(target, target.conversationId, "context-secret");
    await store.remove(target);

    expect(run.mock.calls[0]?.[1]).toEqual([
      "find-generic-password",
      "-s",
      "codexc-weixin-reply-context",
      "-a",
      targetKey,
      "-w",
    ]);
    expect(run.mock.calls[1]?.[1]).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "codexc-weixin-reply-context",
      "-a",
      targetKey,
      "-w",
      JSON.stringify(record),
    ]);
  });
});
