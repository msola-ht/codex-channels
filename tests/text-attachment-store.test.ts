import { mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { FeishuFileInput } from "../src/surfaces/feishu/file-input.js";
import { describe, expect, it, vi } from "vitest";
import { TextAttachmentStore, textAttachmentBody } from "../src/surfaces/text-attachment-store.js";

describe("text attachment store", () => {
  it("keeps small inputs inline and stores larger text privately without putting it in the prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachments-"));
    const store = new TextAttachmentStore(directory, vi.fn());
    try {
      expect(await store.prepare("log")).toEqual({ text: "log" });
      expect(await readdir(directory)).toEqual([]);
      const text = "日志内容\n".repeat(8_000);
      const file = await store.prepare(text);
      expect(file.text).toBe("");
      expect(await readFile(file.path!, "utf8")).toBe(text);
      expect(textAttachmentBody(file)).toContain(file.path);
      expect(textAttachmentBody(file)).not.toContain("日志内容");
      if (process.platform !== "win32") {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(file.path!)).mode & 0o777).toBe(0o600);
      }
      await store.close();
      await expect(store.prepare(text)).rejects.toThrow("已关闭");
      expect(await readFile(file.path!, "utf8")).toBe(text);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("stages only validated and normalized file input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachments-"));
    const store = new TextAttachmentStore(directory, vi.fn());
    const text = "log\n".repeat(10_000);
    let bytes = Buffer.from(`\u001b[32m${text}\u001b[0m`);
    const input = new FeishuFileInput({ downloadFile: async () => ({ stream: Readable.from([bytes]) }) }, store);
    try {
      const file = await input.download("om_message", "file_resource", "server.log");
      expect(file.fileName).toBe("server.log");
      expect(file.bytes).toBe(bytes.length);
      expect(file.text).toBe("");
      expect(await readFile(file.path!, "utf8")).toBe(text);
      bytes = Buffer.from(`invalid\u0000${text}`);
      await expect(input.download("om_message", "file_resource", "server.log")).rejects.toMatchObject({ code: "unsupported" });
      expect(await readdir(directory)).toHaveLength(1);
    } finally { await input.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("discards prepared files idempotently and refuses foreign cleanup paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachments-"));
    const store = new TextAttachmentStore(directory, vi.fn());
    try {
      const file = await store.prepare("x".repeat(40_000));
      await expect(store.discard({ ...file, path: join(directory, "..", "foreign.txt") })).rejects.toThrow("清理路径无效");
      expect(await readFile(file.path!, "utf8")).toHaveLength(40_000);
      await store.discard(file);
      await store.discard(file);
      expect(await readdir(directory)).toEqual([]);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("cleans expired managed files on restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachments-"));
    const first = new TextAttachmentStore(directory, vi.fn());
    const second = new TextAttachmentStore(directory, vi.fn());
    try {
      const file = await first.prepare("x".repeat(40_000));
      await first.close();
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await utimes(file.path!, old, old);
      await second.start();
      expect(await readdir(directory)).toEqual([]);
    } finally { await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("enforces the disk quota under concurrent uploads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachments-"));
    const store = new TextAttachmentStore(directory, vi.fn());
    try {
      const results = await Promise.allSettled(Array.from({ length: 51 }, () => store.prepare("x".repeat(40_000))));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(50);
      expect(results.filter(result => result.status === "rejected")).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ code: "attachment.capacity" }) }),
      ]);
      expect(await readdir(directory)).toHaveLength(50);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
