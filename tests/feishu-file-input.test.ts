import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  FeishuFileInput,
  maximumFeishuTextFileBytes,
} from "../src/surfaces/feishu/file-input.js";

describe("FeishuFileInput", () => {
  it("downloads and decodes one bounded UTF-8 text file in memory", async () => {
    const bytes = Buffer.from("\uFEFF文件内容", "utf8");
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
      message: "飞书当前仅支持 UTF-8 文本文件",
    });
    await expect(
      binary.download("om_message", "file_binary", "../secret.txt"),
    ).rejects.toMatchObject({
      code: "unsupported",
    });
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
