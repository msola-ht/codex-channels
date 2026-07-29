import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

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
