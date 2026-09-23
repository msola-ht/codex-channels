import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Validate the pinned CLI's rendezvous alias without following arbitrary links. */
export function inspectAppServerUnixSocket(socketPath) {
  const uid = process.getuid?.();
  let parent;
  try {
    parent = lstatSync(dirname(socketPath));
  } catch (error) {
    throw new Error("Codex Unix Socket 父目录不可用", { cause: error });
  }
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
    throw new Error("Codex Unix Socket 父目录权限不安全");
  }
  const alias = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!alias) return undefined;
  if (alias.uid !== uid) throw new Error("Codex Unix Socket 必须是当前用户拥有的 Socket");
  const identity = { dev: alias.dev, ino: alias.ino };
  if (alias.isSocket()) return { path: socketPath, identity, available: true };
  if (!alias.isSymbolicLink()) throw new Error("Codex Unix Socket 必须是当前用户拥有的 Socket");

  // Upstream hashes the canonical parent plus basename, independent of TMPDIR/HOME.
  const canonicalAlias = join(realpathSync(dirname(socketPath)), basename(socketPath));
  const directory = join(realpathSync("/tmp"), `codex-daemon-${uid}`);
  const physicalPath = join(directory, createHash("sha256").update(canonicalAlias).digest("hex"));
  if (readlinkSync(socketPath) !== physicalPath) {
    throw new Error("Codex Unix Socket 链接目标不符合锁定版本布局");
  }
  const protectedDirectory = lstatSync(directory, { throwIfNoEntry: false });
  if (!protectedDirectory) return { path: physicalPath, identity, available: false };
  if (!protectedDirectory.isDirectory() || protectedDirectory.uid !== uid
    || (protectedDirectory.mode & 0o777) !== 0o700) {
    throw new Error("Codex Unix Socket 受保护目录权限不安全");
  }
  const socket = lstatSync(physicalPath, { throwIfNoEntry: false });
  if (!socket) return { path: physicalPath, identity, available: false };
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) {
    throw new Error("Codex Unix Socket 受保护目标不安全");
  }
  return { path: physicalPath, identity, available: true };
}
