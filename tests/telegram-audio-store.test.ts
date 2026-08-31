import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { TelegramAudioStore } from "../src/surfaces/telegram/audio-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TelegramAudioStore", () => {
  it("downloads an OGG voice into a private managed directory", async () => {
    const directory = temporaryDirectory();
    const bytes = Buffer.concat([Buffer.from("OggS"), Buffer.from("voice")]);
    const store = new TelegramAudioStore(
      directory,
      "123:secret-token",
      undefined,
      pino({ level: "silent" }),
      async () => ({
        stream: Readable.from([bytes]),
        contentLength: bytes.length,
      }),
    );

    const audio = await store.download(
      { getFile: async () => ({ file_path: "voice/file_1.ogg" }) },
      "telegram-file-id",
    );

    expect(audio).toMatchObject({
      mimeType: "audio/ogg",
      bytes: bytes.length,
    });
    expect(readFileSync(audio.path)).toEqual(bytes);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(audio.path).mode & 0o777).toBe(0o600);
    }
    store.close();
  });

  it("does not expose the Bot token in failures", async () => {
    const store = new TelegramAudioStore(
      temporaryDirectory(),
      "123:secret-token",
      undefined,
      pino({ level: "silent" }),
      async () => {
        throw new Error("https://api.telegram.org/file/bot123:secret-token/x");
      },
    );

    await expect(store.download(
      { getFile: async () => ({ file_path: "voice/file.ogg" }) },
      "file-id",
    )).rejects.toThrow("保存 Telegram 音频失败");
    await expect(store.download(
      { getFile: async () => { throw new Error("123:secret-token"); } },
      "file-id",
    )).rejects.toThrow("无法从 Telegram 获取音频下载信息");
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-telegram-audio-"));
  directories.push(directory);
  return directory;
}
