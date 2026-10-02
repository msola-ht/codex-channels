import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateIpcServer, requestPrivateIpcJson } from "../runtime/private-ipc.mjs";

vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, linkSync: vi.fn(fs.linkSync) };
});

const roots: string[] = [];
vi.mock("node:crypto", async original => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});
afterEach(() => {
  vi.mocked(randomBytes).mockReset();
  vi.mocked(linkSync).mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync("/tmp/ipc-life-");
  roots.push(root);
  const path = join(root, "public.sock");
  const server = new PrivateIpcServer(path, socket => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end('{"ok":true}\n'));
  }, { maximumConnections: 4, connectionTimeoutMs: 1000 });
  return { root, path, server };
}
const query = (path: string) => requestPrivateIpcJson(path, {}, { timeoutMs: 1000, maximumBytes: 128 });

describe.skipIf(process.platform === "win32")("Unix private IPC endpoint ownership", () => {
  it("skips a temporary name that differs from the public endpoint only by case", async () => {
    const { root } = fixture();
    const path = join(root, "s");
    // 0x48 encodes to SA, so the first one-character candidate is S.
    vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.from([0x48]));
    vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.from([0]));
    const server = new PrivateIpcServer(path, socket => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end('{"ok":true}\n'));
    });
    try {
      await server.start("occupied");
      expect(readdirSync(root).sort()).toEqual(["A", "s"]);
      expect(await query(path)).toEqual({ ok: true });
    } finally { await server.close(); }
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects an overlong public name before publishing an unreachable endpoint", async () => {
    const { root } = fixture();
    const capacity = process.platform === "linux" ? 108 : 104;
    const path = join(root, "s".repeat(capacity - Buffer.byteLength(root) - 1));
    const server = new PrivateIpcServer(path, socket => socket.destroy());
    try {
      await expect(server.start("occupied")).rejects.toThrow("长度限制");
      expect(readdirSync(root)).toEqual([]);
      expect(server.listening).toBe(false);
    } finally { await server.close(); }
  });

  it("keeps its binding reserved until close and cleans up both names", async () => {
    const { root, path, server } = fixture();
    try {
      await server.start("occupied");
      expect(readdirSync(root)).toHaveLength(2);
      expect(readdirSync(root)).toContain("public.sock");
      const status = lstatSync(path);
      expect(status.isSocket()).toBe(true);
      expect(status.mode & 0o777).toBe(0o600);
      expect(status.nlink).toBe(2);
      expect(await query(path)).toEqual({ ok: true });
    } finally { await server.close(); }
    expect(readdirSync(root)).toEqual([]);
  });

  it("reserves the binding name against another owner until the listener closes", async () => {
    const { server, root } = fixture();
    await server.start("occupied");
    const boundPath = String(vi.mocked(linkSync).mock.calls[0]![0]);
    const second = new PrivateIpcServer(boundPath, socket => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end('{"second":true}\n'));
    }, { maximumConnections: 4, connectionTimeoutMs: 1000 });
    try {
      await expect(second.start("occupied")).rejects.toThrow("occupied");
      await server.close();
      await second.start("occupied");
      await server.close();
      expect(await query(boundPath)).toEqual({ second: true });
    } finally { await server.close(); await second.close(); }
    expect(readdirSync(root)).toEqual([]);
  });

  it.skipIf(process.platform !== "linux").each([104, 105, 106, 107])(
    "preserves Linux connectivity for a %i-byte public endpoint", async length => {
      const { root } = fixture();
      const path = join(root, "s".repeat(length - Buffer.byteLength(root) - 1));
      const server = new PrivateIpcServer(path, socket => {
        socket.on("error", () => {});
        socket.once("data", () => socket.end('{"ok":true}\n'));
      }, { maximumConnections: 4, connectionTimeoutMs: 1000 });
      try {
        await server.start("occupied");
        expect(await query(path)).toEqual({ ok: true });
      } finally { await server.close(); }
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("preserves a replacement file when closing the original listener", async () => {
    const { root, path, server } = fixture();
    await server.start("occupied");
    renameSync(path, join(root, "original.sock"));
    writeFileSync(path, "replacement", { mode: 0o600 });
    await server.close();
    await server.close();
    expect(readFileSync(path, "utf8")).toBe("replacement");
  });

  it("preserves a replacement listener and keeps it connectable", async () => {
    const { root, path, server } = fixture();
    await server.start("occupied");
    renameSync(path, join(root, "original.sock"));
    const replacement = new PrivateIpcServer(path, socket => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end('{"replacement":true}\n'));
    }, { maximumConnections: 4, connectionTimeoutMs: 1000 });
    try {
      await replacement.start("occupied");
      await server.close();
      expect(await query(path)).toEqual({ replacement: true });
    } finally { await server.close(); await replacement.close(); }
  });

  it("allows exactly one concurrent publisher without deleting the winner", async () => {
    const { path, server } = fixture();
    const contender = new PrivateIpcServer(path, socket => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end('{"ok":true}\n'));
    }, { maximumConnections: 4, connectionTimeoutMs: 1000 });
    try {
      const results = await Promise.allSettled([server.start("occupied"), contender.start("occupied")]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const loser = results[0]!.status === "rejected" ? server : contender;
      await loser.close();
      expect(lstatSync(path).isSocket()).toBe(true);
      expect(await query(path)).toEqual({ ok: true });
    } finally { await server.close(); await contender.close(); }
  });

  it("preserves a file created during publication and can retry after failure", async () => {
    const { root, path, server } = fixture();
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
      writeFileSync(destination, "competitor", { mode: 0o600 });
      original.linkSync(source, destination);
    });
    try {
      await expect(server.start("occupied")).rejects.toThrow("occupied");
      expect(server.listening).toBe(false);
      expect(readdirSync(root)).toEqual(["public.sock"]);
      expect(readFileSync(path, "utf8")).toBe("competitor");
      unlinkSync(path);
      await server.start("occupied");
      expect(await query(path)).toEqual({ ok: true });
    } finally { await server.close(); }
    expect(readdirSync(root)).toEqual([]);
  });

  it("fails closed when Socket publication is unsupported", async () => {
    const { root, server } = fixture();
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("link unsupported"), { code: "EOPNOTSUPP" });
    });
    try {
      await expect(server.start("occupied")).rejects.toThrow("link unsupported");
      expect(server.listening).toBe(false);
      expect(readdirSync(root)).toEqual([]);
    } finally { await server.close(); }
  });

  it("recovers a stale published endpoint and cleans up the new binding", async () => {
    const { root, path, server } = fixture();
    const stale = createServer();
    const bound = join(root, "stale.sock");
    await new Promise<void>(resolve => stale.listen(bound, resolve));
    linkSync(bound, path);
    await new Promise<void>(resolve => stale.close(() => resolve()));
    // Match a previously published endpoint's permissions.
    chmodSync(path, 0o600);
    try {
      await server.start("occupied");
      expect(await query(path)).toEqual({ ok: true });
      expect(readdirSync(root)).toHaveLength(2);
    } finally { await server.close(); }
    expect(readdirSync(root)).toEqual([]);
  });

  it("does not lengthen a 103-byte endpoint with a short basename", async () => {
    const { root } = fixture();
    const parent = join(root, "d".repeat(103 - Buffer.byteLength(root) - 3));
    mkdirSync(parent, { mode: 0o700 });
    const path = join(parent, "s");
    expect(Buffer.byteLength(path)).toBe(103);
    const server = new PrivateIpcServer(path, socket => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end('{"ok":true}\n'));
    }, { maximumConnections: 4, connectionTimeoutMs: 1000 });
    try {
      await server.start("occupied");
      expect(await query(path)).toEqual({ ok: true });
    } finally { await server.close(); }
    expect(readdirSync(parent)).toEqual([]);
  });
});
