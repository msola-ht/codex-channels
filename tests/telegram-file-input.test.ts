import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  maximumTelegramTextFileBytes,
  TelegramTextFileInput,
  type TelegramTextFileDownloader,
} from "../src/surfaces/telegram/file-input.js";

describe("TelegramTextFileInput", () => {
  it("downloads and decodes one bounded UTF-8 text file in memory", async () => {
    let requestedUrl: URL | undefined;
    const downloader: TelegramTextFileDownloader = vi.fn(async (url) => {
      requestedUrl = url;
      return {
        stream: Readable.from([Buffer.from("\uFEFF发布说明", "utf8")]),
        contentLength: Buffer.byteLength("\uFEFF发布说明", "utf8"),
      };
    });
    const input = new TelegramTextFileInput(
      "123:secret-token",
      undefined,
      downloader,
    );

    await expect(input.download(
      { getFile: async () => ({ file_path: "documents/file_1.txt" }) },
      "telegram-file-id",
      "发布说明.txt",
    )).resolves.toEqual({
      fileName: "发布说明.txt",
      text: "发布说明",
      bytes: Buffer.byteLength("\uFEFF发布说明", "utf8"),
    });
    expect(requestedUrl?.hostname).toBe("api.telegram.org");
    expect(requestedUrl?.pathname).toContain("/documents/file_1.txt");
    expect(requestedUrl?.href).toContain("123:secret-token");
  });

  it("rejects unsafe, oversized, binary, and empty files without leaking content", async () => {
    const input = new TelegramTextFileInput(
      "123:secret-token",
      undefined,
      async () => ({
        stream: Readable.from([Buffer.from("unused")]),
        contentLength: maximumTelegramTextFileBytes + 1,
      }),
    );

    await expect(input.download(
      { getFile: async () => ({ file_path: "documents/file.txt" }) },
      "file-id",
      "../secret.txt",
    )).rejects.toThrow("仅支持 UTF-8 文本文件");
    await expect(input.download(
      { getFile: async () => ({ file_path: "../secret" }) },
      "file-id",
      "notes.txt",
    )).rejects.toThrow("下载 Telegram 文件失败");
    await expect(input.download(
      { getFile: async () => ({ file_path: "documents/file.txt" }) },
      "file-id",
      "notes.txt",
    )).rejects.toThrow("超过 1,000,000 字节");

    const unsupported = new TelegramTextFileInput(
      "123:secret-token",
      undefined,
      async () => ({
        stream: Readable.from([Buffer.from([0xff, 0xfe, 0x00, 0x01])]),
      }),
    );
    await expect(unsupported.download(
      { getFile: async () => ({ file_path: "documents/file.bin" }) },
      "file-id",
      "binary.bin",
    )).rejects.toThrow("仅支持 UTF-8 文本文件");

    const empty = new TelegramTextFileInput(
      "123:secret-token",
      undefined,
      async () => ({ stream: Readable.from([]) }),
    );
    await expect(empty.download(
      { getFile: async () => ({ file_path: "documents/empty.txt" }) },
      "file-id",
      "empty.txt",
    )).rejects.toThrow("仅支持 UTF-8 文本文件");
  });
});
