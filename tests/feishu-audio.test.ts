import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { FeishuAudioStore } from "../src/surfaces/feishu/index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FeishuAudioStore", () => {
  it("stores a downloaded OGG resource with private permissions", async () => {
    const directory = temporaryDirectory();
    const bytes = Buffer.concat([Buffer.from("OggS"), Buffer.from("voice")]);
    const store = new FeishuAudioStore(
      directory,
      {
        downloadAudio: async () => ({
          stream: Readable.from([bytes]),
          contentLength: bytes.length,
        }),
      },
      pino({ level: "silent" }),
    );

    const audio = await store.download("om_message", "file_resource");

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

  it("fails closed on unsafe resource identifiers", async () => {
    const store = new FeishuAudioStore(
      temporaryDirectory(),
      { downloadAudio: async () => { throw new Error("not called"); } },
      pino({ level: "silent" }),
    );

    await expect(store.download("../message", "file")).rejects.toThrow(
      "飞书音频资源标识无效",
    );
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-audio-"));
  directories.push(directory);
  return directory;
}
