import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WeixinAudioStore } from "../src/surfaces/weixin/index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WeixinAudioStore", () => {
  it("downloads and privately stores directly supported MP3 audio", async () => {
    const plaintext = Buffer.concat([
      Buffer.from("ID3"),
      Buffer.from("audio"),
    ]);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(plaintext, {
        status: 200,
        headers: { "content-length": String(plaintext.length) },
      }));
    const directory = temporaryDirectory();
    const store = new WeixinAudioStore(
      directory,
      pino({ level: "silent" }),
      fetchImpl,
    );

    const audio = await store.download({
      encodeType: 7,
      durationMs: 12_000,
      encryptedQueryParam: "private-query",
    });

    expect(audio).toMatchObject({
      mimeType: "audio/mpeg",
      bytes: plaintext.length,
    });
    expect(readFileSync(audio.path)).toEqual(plaintext);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(audio.path).mode & 0o777).toBe(0o600);
    }
    store.close();
  });

  it("rejects missing duration and SILK before downloading, and enforces duration", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const store = new WeixinAudioStore(
      temporaryDirectory(),
      pino({ level: "silent" }),
      fetchImpl,
    );

    await expect(store.download({
      encodeType: 7,
      encryptedQueryParam: "private-query",
    })).rejects.toMatchObject({
      code: "audio.duration-missing",
      message: "无法确认微信语音时长，请重新发送",
    });
    await expect(store.download({
      encodeType: 6,
      durationMs: 12_000,
      encryptedQueryParam: "private-query",
    })).rejects.toMatchObject({
      code: "audio.unsupported",
      message: "微信 SILK 语音暂不受 Codex CLI 支持",
    });
    await expect(store.download({
      encodeType: 7,
      durationMs: 5 * 60 * 1_000 + 1,
      encryptedQueryParam: "private-query",
    })).rejects.toMatchObject({
      code: "audio.too-large",
      message: "语音超过 5 分钟限制",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-weixin-audio-"));
  directories.push(directory);
  return directory;
}
