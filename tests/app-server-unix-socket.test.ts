import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { inspectAppServerUnixSocket } from "../runtime/app-server-unix-socket.mjs";

vi.mock("node:fs", () => ({ lstatSync: vi.fn(), readlinkSync: vi.fn(), realpathSync: vi.fn() }));

const uid = process.getuid?.();
const alias = "/private/runtime/app.sock";
const directory = `/private/tmp/codex-daemon-${uid}`;
const physical = `${directory}/${createHash("sha256").update(alias).digest("hex")}`;
const entries = new Map<string, Stats>();

function metadata(kind: "directory" | "socket" | "link" | "file", mode: number, owner = uid): Stats {
  return { uid: owner, mode, dev: 1, ino: 2,
    isDirectory: () => kind === "directory", isSocket: () => kind === "socket",
    isSymbolicLink: () => kind === "link",
  } as Stats;
}

beforeEach(() => {
  vi.resetAllMocks();
  entries.clear();
  entries.set("/private/runtime", metadata("directory", 0o700));
  entries.set(alias, metadata("link", 0o777));
  entries.set(directory, metadata("directory", 0o700));
  entries.set(physical, metadata("socket", 0o600));
  vi.mocked(lstatSync).mockImplementation(((path: string) => entries.get(path)) as typeof lstatSync);
  vi.mocked(readlinkSync).mockReturnValue(physical);
  vi.mocked(realpathSync).mockImplementation(((path: string) => path === "/tmp" ? "/private/tmp" : path) as typeof realpathSync);
});

describe.skipIf(process.platform === "win32")("pinned App Server Unix socket layout", () => {
  it("resolves the exact protected socket independently of environment paths", () => {
    expect(inspectAppServerUnixSocket(alias)).toEqual({ path: physical, identity: { dev: 1, ino: 2 }, available: true });
  });

  it.each(["/private/other.sock", `${directory}/wrong-hash`, "relative-target"])("rejects an arbitrary alias target %s", (target) => {
    vi.mocked(readlinkSync).mockReturnValue(target);
    expect(() => inspectAppServerUnixSocket(alias)).toThrow("链接目标");
  });

  it.each([
    ["/private/runtime", "directory", 0o755, uid],
    ["/private/runtime", "link", 0o700, uid],
    [alias, "link", 0o777, (uid ?? 0) + 1],
    [directory, "directory", 0o755, uid],
    [directory, "link", 0o700, uid],
    [directory, "directory", 0o700, (uid ?? 0) + 1],
    [physical, "socket", 0o666, uid],
    [physical, "socket", 0o600, (uid ?? 0) + 1],
    [physical, "link", 0o600, uid],
    [physical, "file", 0o600, uid],
  ] as const)("rejects unsafe metadata at %s (%s, %s, %s)", (path, kind, mode, owner) => {
    entries.set(path, metadata(kind, mode, owner));
    expect(() => inspectAppServerUnixSocket(alias)).toThrow();
  });

  it("distinguishes a missing alias from a valid dangling alias without following links", () => {
    entries.delete(physical);
    expect(inspectAppServerUnixSocket(alias)).toMatchObject({ path: physical, available: false });
    entries.delete(alias);
    expect(inspectAppServerUnixSocket(alias)).toBeUndefined();
  });
});
