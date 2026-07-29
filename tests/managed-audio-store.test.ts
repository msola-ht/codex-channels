import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManagedAudioStore,
  maximumManagedAudioBytes,
} from "../src/surfaces/managed-audio-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ManagedAudioStore", () => {
  it.each([
    ["wav", wavBytes(), "audio/wav"],
    ["mp3", Buffer.from("ID3test"), "audio/mpeg"],
    ["m4a", Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypM4A "), 0, 0, 0, 0]), "audio/mp4"],
    ["webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), "audio/webm"],
    ["ogg", Buffer.from("OggStest"), "audio/ogg"],
  ] as const)("stores detected %s audio privately", async (_extension, bytes, mimeType) => {
    const directory = temporaryDirectory();
    const store = new ManagedAudioStore(directory, vi.fn());
    await store.start();

    const result = await store.store({
      stream: Readable.from([bytes]),
      contentLength: bytes.length,
    });

    expect(result.mimeType).toBe(mimeType);
    expect(readFileSync(result.path)).toEqual(bytes);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    store.close();
  });

  it("rejects unsupported and oversized audio", async () => {
    const directory = temporaryDirectory();
    const store = new ManagedAudioStore(directory, vi.fn());
    await store.start();

    await expect(store.store({
      stream: Readable.from([Buffer.from("not audio")]),
    })).rejects.toThrow("仅支持 WAV、MP3、M4A、WebM 和 OGG");
    await expect(store.store({
      stream: Readable.from([]),
      contentLength: maximumManagedAudioBytes + 1,
    })).rejects.toThrow("超过 20 MiB");
    store.close();
  });

  it("removes expired managed audio when starting", async () => {
    const directory = temporaryDirectory();
    const expired = join(directory, "00000000-0000-0000-0000-000000000000.ogg");
    writeFileSync(expired, Buffer.from("OggStest"), { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    utimesSync(expired, old, old);
    const store = new ManagedAudioStore(directory, vi.fn(), 1);

    await store.start();

    expect(() => statSync(expired)).toThrow();
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-managed-audio-"));
  directories.push(directory);
  return directory;
}

function wavBytes(): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVEfmt "),
  ]);
}
