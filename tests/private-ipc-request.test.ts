import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateIpcServer, requestPrivateIpcJson } from "../runtime/private-ipc.mjs";

async function withPeer(handle: (socket: Socket) => void, run: (path: string) => Promise<void>) {
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ipc-req-"));
  const path = join(root, "s");
  const server = new PrivateIpcServer(path, socket => {
    socket.on("error", () => {});
    socket.once("data", () => handle(socket));
  }, { maximumConnections: 4, connectionTimeoutMs: 1000 });
  try {
    await server.start("occupied");
    await run(path);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const options = { timeoutMs: 1000, maximumBytes: 128 };

describe("private IPC JSON request lifecycle", () => {
  it("reads fragmented UTF-8 JSON and releases the connection and abort listener", async () => {
    let closed!: Promise<void>;
    const controller = new AbortController();
    await withPeer(socket => {
      closed = new Promise(resolve => socket.once("close", resolve));
      socket.on("end", () => socket.destroy());
      const frame = Buffer.from('{"text":"中文"}\n');
      const split = Buffer.byteLength('{"text":"') + 1;
      socket.write(frame.subarray(0, split));
      setTimeout(() => socket.write(frame.subarray(split)), 10);
    }, async path => {
      expect(await requestPrivateIpcJson(path, { request: 1 }, { ...options, signal: controller.signal }))
        .toEqual({ text: "中文" });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      await closed;
    });
  });

  it.each(["oversized", "invalid", "truncated", "timeout"] as const)("rejects %s responses without retry", async mode => {
    let requests = 0;
    await withPeer(socket => {
      requests++;
      if (mode === "oversized") socket.end(`${JSON.stringify("x".repeat(128))}\n`);
      if (mode === "invalid") socket.end("not-json\n");
      if (mode === "truncated") socket.end('{"text":');
    }, async path => {
      await expect(requestPrivateIpcJson(path, {}, { ...options, timeoutMs: 250 })).rejects.toThrow("unconfirmed");
      expect(requests).toBe(1);
    });
  });

  it("cancels an active exchange and removes the abort listener", async () => {
    const controller = new AbortController();
    await withPeer(() => controller.abort(), async path => {
      await expect(requestPrivateIpcJson(path, {}, { ...options, signal: controller.signal })).rejects.toThrow("unconfirmed");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });
  });

  it("does not connect when already cancelled", async () => {
    let requests = 0;
    await withPeer(() => { requests++; }, async path => {
      await expect(requestPrivateIpcJson(path, {}, { ...options, signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
      expect(requests).toBe(0);
    });
  });

  it("rejects a missing endpoint", async () => {
    const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ipc-req-"));
    try {
      await expect(requestPrivateIpcJson(join(root, "missing"), {}, options)).rejects.toThrow("unconfirmed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
