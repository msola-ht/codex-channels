import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  decodeUtf8TextFile,
  isSafeTextFileName,
  normalizeTextFileName,
  readBoundedTextFile,
} from "../src/surfaces/text-file-input.js";

describe("text file input", () => {
  it("normalizes safe names while preserving platform length semantics", () => {
    expect(normalizeTextFileName(
      " 发布说明.txt ",
      { maximumUtf8Bytes: 255 },
    )).toBe("发布说明.txt");
    const unicodeName = `${"测".repeat(100)}.txt`;
    expect(isSafeTextFileName(
      unicodeName,
      { maximumUtf8Bytes: 255 },
    )).toBe(false);
    expect(isSafeTextFileName(
      unicodeName,
      { maximumCodeUnits: 255 },
    )).toBe(true);
    expect(() => normalizeTextFileName(
      "../secret.txt",
      { maximumUtf8Bytes: 255 },
    )).toThrow("文本文件校验失败");
  });

  it("strictly decodes UTF-8, removes BOM and rejects controls", () => {
    expect(decodeUtf8TextFile(
      Buffer.from("\uFEFF发布说明", "utf8"),
    )).toBe("发布说明");
    expect(() => decodeUtf8TextFile(Buffer.from([0xc3, 0x28])))
      .toThrow("文本文件校验失败");
    expect(() => decodeUtf8TextFile(Buffer.from("a\u0000b")))
      .toThrow("文本文件校验失败");
    expect(() => decodeUtf8TextFile(Buffer.alloc(0)))
      .toThrow("文本文件校验失败");
  });

  it("normalizes terminal logs while preserving text, line endings and tabs", () => {
    const log = "\uFEFF\u001b[32mINFO\u001b[0m\t连接已关闭\r\n"
      + "\u001b]8;;https://example.com\u0007详情\u001b]8;;\u0007\n";
    expect(decodeUtf8TextFile(Buffer.from(log)))
      .toBe("INFO\t连接已关闭\r\n详情\n");
  });

  it.each<[Buffer, string]>([
    [Buffer.from([0xc3, 0x28]), "invalid-utf8"],
    [Buffer.alloc(0), "empty"],
    [Buffer.from("\u001b[32m\u001b[0m"), "empty"],
    [Buffer.from("log\u0000data"), "control-characters"],
    [Buffer.from("log\u0008data"), "control-characters"],
    [Buffer.from("log\u001b["), "control-characters"],
  ])("reports the reason for rejected content %#", (bytes, code) => {
    expect(() => decodeUtf8TextFile(bytes)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("bounds the entire stream read even while chunks keep arriving", async () => {
    vi.useFakeTimers();
    const stream = new Readable({ read() {} });
    try {
      const reading = readBoundedTextFile(stream);
      const rejected = expect(reading).rejects.toMatchObject({ code: "read-timeout" });
      for (let second = 0; second < 30; second++) {
        stream.push(Buffer.from("x"));
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await rejected;
      expect(stream.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stream.destroy();
      vi.useRealTimers();
    }
  });

  it("clears the read deadline after both success and size rejection", async () => {
    vi.useFakeTimers();
    try {
      await expect(readBoundedTextFile(Readable.from([Buffer.from("ok")]))).resolves.toEqual(Buffer.from("ok"));
      expect(vi.getTimerCount()).toBe(0);
      const stream = Readable.from([Buffer.from("large")]);
      await expect(readBoundedTextFile(stream, 1)).rejects.toMatchObject({ code: "too-large" });
      expect(stream.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads bounded byte streams and rejects invalid chunks", async () => {
    await expect(readBoundedTextFile(
      Readable.from([Buffer.from("ab"), Buffer.from("cd")]),
      4,
    )).resolves.toEqual(Buffer.from("abcd"));
    await expect(readBoundedTextFile(
      Readable.from([Buffer.from("abcde")]),
      4,
    )).rejects.toMatchObject({ code: "too-large" });
    await expect(readBoundedTextFile(
      Readable.from(["text"]),
      4,
    )).rejects.toMatchObject({ code: "unsupported" });
  });
});
