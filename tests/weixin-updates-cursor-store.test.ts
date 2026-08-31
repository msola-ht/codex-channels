import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileWeixinUpdatesCursorStore } from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";

describe("FileWeixinUpdatesCursorStore", () => {
  it("returns null without creating a directory for a missing cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-weixin-cursor-"));
    const directory = join(root, "data", "weixin-updates");
    const store = new FileWeixinUpdatesCursorStore(directory);

    await expect(store.get(accountId)).resolves.toBeNull();
    expect(() => statSync(directory)).toThrow();
  });

  it("atomically replaces a strict private v1 record", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-weixin-cursor-"));
    const directory = join(root, "data", "weixin-updates");
    const store = new FileWeixinUpdatesCursorStore(directory);

    await store.set(accountId, "cursor-one");
    await store.set(accountId, "cursor-two");

    expect(await store.get(accountId)).toBe("cursor-two");
    if (process.platform !== "win32") expect(statSync(directory).mode & 0o777).toBe(0o700);
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(files[0]).not.toContain("account-fixture");
    const path = join(directory, files[0]!);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      accountId,
      cursor: "cursor-two",
    });
  });

  it("fails closed on unknown, mismatched, or corrupted records", async () => {
    const fixture = await storedFixture();
    writeFileSync(fixture.path, JSON.stringify({
      version: 2,
      accountId,
      cursor: "cursor",
    }), { mode: 0o600 });
    await expect(fixture.store.get(accountId)).rejects.toThrow(
      "读取微信消息游标失败",
    );

    writeFileSync(fixture.path, JSON.stringify({
      version: 1,
      accountId: "other@im.bot",
      cursor: "cursor",
    }), { mode: 0o600 });
    await expect(fixture.store.get(accountId)).rejects.toThrow(
      "读取微信消息游标失败",
    );

    writeFileSync(fixture.path, "{broken", { mode: 0o600 });
    await expect(fixture.store.get(accountId)).rejects.toThrow(
      "读取微信消息游标失败",
    );
  });

  it("repairs private modes and removes only the requested account", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-weixin-cursor-"));
    const directory = join(root, "data", "weixin-updates");
    const store = new FileWeixinUpdatesCursorStore(directory);
    const secondAccountId = "second-fixture@im.bot";
    await store.set(accountId, "cursor-one");
    await store.set(secondAccountId, "cursor-two");
    chmodSync(directory, 0o755);
    for (const file of readdirSync(directory)) {
      chmodSync(join(directory, file), 0o644);
    }

    expect(await store.get(accountId)).toBe("cursor-one");
    if (process.platform !== "win32") expect(statSync(directory).mode & 0o777).toBe(0o700);
    await store.remove(accountId);

    await expect(store.get(accountId)).resolves.toBeNull();
    await expect(store.get(secondAccountId)).resolves.toBe("cursor-two");
    await expect(store.remove(accountId)).resolves.toBeUndefined();
  });

  it("rejects a symlinked cursor directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-weixin-cursor-"));
    const target = mkdtempSync(join(tmpdir(), "codexc-weixin-cursor-target-"));
    const directory = join(root, "weixin-updates");
    symlinkSync(target, directory, "dir");
    const store = new FileWeixinUpdatesCursorStore(directory);

    await expect(store.get(accountId)).rejects.toThrow(
      "微信消息游标目录无效",
    );
    await expect(store.set(accountId, "cursor")).rejects.toThrow(
      "微信消息游标目录无效",
    );
  });
});

async function storedFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-weixin-cursor-"));
  const directory = join(root, "data", "weixin-updates");
  const store = new FileWeixinUpdatesCursorStore(directory);
  await store.set(accountId, "cursor");
  return {
    store,
    path: join(directory, readdirSync(directory)[0]!),
  };
}
