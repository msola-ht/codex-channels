import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  FeishuFileInput,
  maximumFeishuTextFileBytes,
} from "../src/surfaces/feishu/file-input.js";

describe("FeishuFileInput", () => {
  it("downloads and decodes one bounded UTF-8 text file in memory", async () => {
    const bytes = Buffer.from("\uFEFF\u001b[32m文件内容\u001b[0m", "utf8");
    const downloadFile = vi.fn(async () => ({
      stream: Readable.from([bytes]),
      contentLength: bytes.length,
    }));
    const input = new FeishuFileInput({ downloadFile });

    await expect(
      input.download("om_message", "file_v2_resource", " settings.json "),
    ).resolves.toEqual({
      fileName: "settings.json",
      text: "文件内容",
      bytes: bytes.length,
    });
    expect(downloadFile).toHaveBeenCalledWith(
      "om_message",
      "file_v2_resource",
    );
  });

  it("rejects oversized, binary, and unsafe-name files", async () => {
    const oversized = new FeishuFileInput({
      downloadFile: async () => ({
        stream: Readable.from([]),
        contentLength: maximumFeishuTextFileBytes + 1,
      }),
    });
    await expect(
      oversized.download("om_message", "file_large", "large.txt"),
    ).rejects.toMatchObject({
      code: "too-large",
      message: "飞书文本文件超过 1,000,000 字节限制",
    });

    const binary = new FeishuFileInput({
      downloadFile: async () => ({
        stream: Readable.from([Buffer.from([0xc3, 0x28])]),
      }),
    });
    await expect(
      binary.download("om_message", "file_binary", "binary.txt"),
    ).rejects.toMatchObject({
      code: "unsupported",
      message: "网关无法读取飞书附件：文件不是有效的 UTF-8 文本，请转换编码后重新发送",
    });
    await expect(
      binary.download("om_message", "file_binary", "../secret.txt"),
    ).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("returns a safe timeout reason and closes a stalled resource", async () => {
    vi.useFakeTimers();
    const stream = new Readable({ read() {} });
    try {
      const input = new FeishuFileInput({ downloadFile: async () => ({ stream }) });
      const downloading = input.download("om_message", "file_resource", "server.log");
      const rejected = expect(downloading).rejects.toMatchObject({
        code: "download-failed",
        message: expect.stringContaining("文件读取超过 30 秒"),
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(stream.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stream.destroy();
      vi.useRealTimers();
    }
  });

  it.each([-1, Number.NaN, 1.5])("rejects invalid declared length %s as a download failure", async (contentLength) => {
    const stream = Readable.from([Buffer.from("log")]);
    const input = new FeishuFileInput({ downloadFile: async () => ({ stream, contentLength }) });
    await expect(input.download("om_message", "file_resource", "log.txt"))
      .rejects.toMatchObject({ code: "download-failed" });
    expect(stream.destroyed).toBe(true);
  });

  it("does not expose resource download error details", async () => {
    const input = new FeishuFileInput({
      downloadFile: async () => {
        throw new Error("Authorization: secret");
      },
    });

    await expect(
      input.download("om_message", "file_secret", "notes.txt"),
    ).rejects.toMatchObject({
      code: "download-failed",
      message: "下载飞书文件失败，请重新发送",
    });
    await expect(
      input.download("om_message", "file_secret", "notes.txt"),
    ).rejects.not.toThrow("secret");
  });
});
