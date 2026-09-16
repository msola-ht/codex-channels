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

import { afterEach, describe, expect, it } from "vitest";

import { EncryptedFileFeishuUserTokenStore } from "../src/surfaces/feishu/oauth-token-store.js";
import { storedFeishuToken as storedToken } from "./feishu-oauth-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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
      if (process.platform !== "win32") {
        expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
      }
      expect(readFileSync(join(directory, file)).includes(
        Buffer.from("access-secret"),
      )).toBe(false);
    }
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
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

});
