import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { inspectPrivateDirectoryAccess, inspectPrivateDirectoryAccessSync } from "../../runtime/private-file.mjs";
import { projectTrafficDumpManifest } from "../../runtime/traffic-dump-manifest.mjs";
import type { TrafficDumpManifest } from "../../runtime/traffic-dump-manifest.mjs";

export const modelTrafficDumpFileSizeLimitBytes = 64 * 1_048_576;
/** 同一 Provider 的历史完整 session 约保留 320 MiB；当前 session 不在写入中途删除。 */
const retainedBytesPerLabel = 5 * modelTrafficDumpFileSizeLimitBytes;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const activeSessionDirectories = new Set<string>();

/** All writers in this process protect their identity before asynchronous directory preparation. */
export function protectModelTrafficDumpSession(directory: string): () => void {
  activeSessionDirectories.add(directory);
  return () => { activeSessionDirectories.delete(directory); };
}

export interface PruneModelTrafficDumpOptions {
  /** 转储根目录。 */
  directory: string;
  /** 只清理指定 Provider；省略时清理自有 V2 Provider；Relay 由独立 owner 显式清理。 */
  label?: string;
  /** Explicit labels share one total budget, used by the Relay owner. */
  labels?: readonly string[];
  /** 历史 session 的最长保留天数；`0` 关闭按时间清理。 */
  retentionDays: number;
  maximumBytes?: number;
  /** 当前写入目录；清理时始终保留。 */
  currentSessionDirectory?: string;
  /** 仍有调用或文件流归属的目录；清理时始终保留。 */
  protectedSessionDirectories?: readonly string[];
  /** Consult the live writer registry immediately before deleting a planned session. */
  isProtected?: (directory: string) => boolean;
}

type DirectoryIdentity = { dev: number; ino: number };
type ManifestSnapshot = { manifest: TrafficDumpManifest; metadata: Stats };
type RetainedSession = { createdAtMs: number; lastActivityAtMs: number; path: string; size: number;
  identity: DirectoryIdentity; manifest: ManifestSnapshot };

/** 清理可识别的 V2 历史 session；未知目录与旧版文件保持不变。 */
export function pruneModelTrafficDumpSessions(options: PruneModelTrafficDumpOptions): number {
  const root = optionalRootSync(options.directory);
  if (root === undefined) return 0;
  const scan = { entries: 0 };
  const byLabel = new Map<string, RetainedSession[]>();
  for (const entry of readdirSync(options.directory, { withFileTypes: true })) {
    countScannedEntry(scan);
    if (!entry.isDirectory()) continue;
    const path = join(options.directory, entry.name);
    // An unrelated directory without a manifest is not a retention candidate.
    try { lstatSync(join(path, "manifest.json")); } catch (error) { if (missing(error)) continue; throw error; }
    assertDirectoryIdentitySync(options.directory, root);
    const identity = inspectPrivateDirectoryAccessSync(path);
    const snapshot = readManifest(path);
    assertDirectoryIdentitySync(path, identity);
    assertDirectoryIdentitySync(options.directory, root);
    if (snapshot === undefined) continue;
    const manifest = snapshot.manifest;
    if (manifest.version !== 2 || (!options.label && !options.labels && ["relay.chat", "relay.responses"].includes(manifest.label)) || (options.label !== undefined && manifest.label !== options.label) || (options.labels !== undefined && !options.labels.includes(manifest.label))) {
      continue;
    }
    const sessions = byLabel.get(options.labels ? "combined" : manifest.label) ?? [];
    const stats = directoryStats(path, scan);
    assertDirectoryIdentitySync(path, identity);
    assertDirectoryIdentitySync(options.directory, root);
    sessions.push({
      createdAtMs: manifest.createdAtMs,
      lastActivityAtMs: Math.max(manifest.createdAtMs, stats.lastModifiedAtMs),
      path,
      size: stats.size,
      identity,
      manifest: snapshot,
    });
    byLabel.set(options.labels ? "combined" : manifest.label, sessions);
  }
  assertDirectoryIdentitySync(options.directory, root);
  const result = planRetention(options, byLabel);
  for (const session of result.remove) {
    if (isProtectedSession(options, session.path)) { result.bytes += session.size; continue; }
    assertDirectoryIdentitySync(options.directory, root);
    assertDirectoryIdentitySync(session.path, session.identity);
    assertManifestSnapshot(session.manifest, readManifest(session.path));
    assertDirectoryIdentitySync(session.path, session.identity);
    assertDirectoryIdentitySync(options.directory, root);
    rmSync(session.path, { force: true, recursive: true });
  }
  return result.bytes;
}

/** Async maintenance protects the writer's snapshot plus sessions created during the scan. */
export async function pruneModelTrafficDumpSessionsAsync(options: PruneModelTrafficDumpOptions & {
  onRemoved?: (bytes: number) => void;
}, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const root = await optionalRoot(options.directory, signal);
  if (root === undefined) return 0;
  const directory = await fs.opendir(options.directory);
  const scan = { entries: 0 };
  const byLabel = new Map<string, RetainedSession[]>();
  for await (const entry of directory) {
    signal.throwIfAborted();
    countScannedEntry(scan);
    if (!entry.isDirectory()) continue;
    const path = join(options.directory, entry.name);
    try { await fs.lstat(join(path, "manifest.json")); } catch (error) { signal.throwIfAborted(); if (missing(error)) continue; throw error; }
    await assertDirectoryIdentity(options.directory, root, signal);
    const identity = await inspectPrivateDirectoryAccess(path, { signal });
    const snapshot = await readManifestAsync(path, signal);
    await assertDirectoryIdentity(path, identity, signal);
    await assertDirectoryIdentity(options.directory, root, signal);
    if (snapshot === undefined) continue;
    const manifest = snapshot.manifest;
    if (manifest.version !== 2 || (!options.label && !options.labels && ["relay.chat", "relay.responses"].includes(manifest.label))
      || (options.label !== undefined && manifest.label !== options.label) || (options.labels !== undefined && !options.labels.includes(manifest.label))) continue;
    const stats = await directoryStatsAsync(path, signal, scan).catch((error: unknown) => {
      // Another maintenance owner may have removed an inactive session while this scan yielded.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) continue;
    await assertDirectoryIdentity(path, identity, signal);
    await assertDirectoryIdentity(options.directory, root, signal);
    const sessions = byLabel.get(options.labels ? "combined" : manifest.label) ?? [];
    sessions.push({ path, createdAtMs: manifest.createdAtMs, lastActivityAtMs: Math.max(manifest.createdAtMs, stats.lastModifiedAtMs), size: stats.size,
      identity, manifest: snapshot });
    byLabel.set(options.labels ? "combined" : manifest.label, sessions);
  }
  await assertDirectoryIdentity(options.directory, root, signal);
  const result = planRetention(options, byLabel);
  for (const session of result.remove) {
    signal.throwIfAborted();
    // The owner may have created a writer session after the plan was computed.
    if (isProtectedSession(options, session.path)) { result.bytes += session.size; continue; }
    await assertDirectoryIdentity(options.directory, root, signal);
    await assertDirectoryIdentity(session.path, session.identity, signal);
    assertManifestSnapshot(session.manifest, await readManifestAsync(session.path, signal));
    await assertDirectoryIdentity(session.path, session.identity, signal);
    await assertDirectoryIdentity(options.directory, root, signal);
    signal.throwIfAborted();
    // No asynchronous gap after the final live-writer check and deletion submission.
    if (isProtectedSession(options, session.path)) { result.bytes += session.size; continue; }
    await fs.rm(session.path, { force: true, recursive: true });
    options.onRemoved?.(session.size);
  }
  signal.throwIfAborted();
  return result.bytes;
}

function planRetention(options: PruneModelTrafficDumpOptions, byLabel: Map<string, RetainedSession[]>): { bytes: number; remove: RetainedSession[] } {
  const protectedDirectories = new Set(options.protectedSessionDirectories ?? []);
  if (options.currentSessionDirectory !== undefined) protectedDirectories.add(options.currentSessionDirectory);
  const oldestRetainedAtMs = options.retentionDays === 0 ? null : Date.now() - options.retentionDays * millisecondsPerDay;
  const remove: RetainedSession[] = [];
  let bytes = 0;
  for (const sessions of byLabel.values()) {
    sessions.sort((left, right) => right.lastActivityAtMs - left.lastActivityAtMs || right.createdAtMs - left.createdAtMs);
    let retained = 0;
    for (const session of sessions) {
      const protectedSession = activeSessionDirectories.has(session.path) || protectedDirectories.has(session.path) || options.isProtected?.(session.path) === true;
      if (!protectedSession && oldestRetainedAtMs !== null && session.lastActivityAtMs < oldestRetainedAtMs) {
        remove.push(session); continue;
      }
      retained += session.size;
      if (protectedSession || retained <= (options.maximumBytes ?? retainedBytesPerLabel)) bytes += session.size;
      else remove.push(session);
    }
  }
  return { bytes, remove };
}

const maximumManifestBytes = 16_384;

function parseManifest(text: string): TrafficDumpManifest {
  let manifest: TrafficDumpManifest | undefined;
  try { manifest = projectTrafficDumpManifest(JSON.parse(text)); } catch { /* Fixed diagnostic below. */ }
  if (manifest === undefined) throw new Error("Traffic dump maintenance manifest invalid");
  return manifest;
}

function sameIdentity(expected: DirectoryIdentity, actual: DirectoryIdentity): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

function sameFile(expected: Stats, actual: Stats): boolean {
  return actual.isFile() && sameIdentity(expected, actual) && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

function assertManifestSnapshot(expected: ManifestSnapshot, actual: ManifestSnapshot | undefined): void {
  if (actual === undefined || !sameFile(expected.metadata, actual.metadata)
    || JSON.stringify(expected.manifest) !== JSON.stringify(actual.manifest)) {
    throw new Error("Traffic dump maintenance manifest changed");
  }
}

function assertDirectoryIdentitySync(path: string, expected: DirectoryIdentity): void {
  if (!sameIdentity(expected, inspectPrivateDirectoryAccessSync(path))) throw new Error("Traffic dump maintenance directory changed");
}

async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity, signal: AbortSignal): Promise<void> {
  if (!sameIdentity(expected, await inspectPrivateDirectoryAccess(path, { signal }))) throw new Error("Traffic dump maintenance directory changed");
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function optionalRootSync(path: string): DirectoryIdentity | undefined {
  try { lstatSync(path); } catch (error) { if (missing(error)) return undefined; throw error; }
  return inspectPrivateDirectoryAccessSync(path);
}

async function optionalRoot(path: string, signal: AbortSignal): Promise<DirectoryIdentity | undefined> {
  try { await fs.lstat(path); } catch (error) { signal.throwIfAborted(); if (missing(error)) return undefined; throw error; }
  return inspectPrivateDirectoryAccess(path, { signal });
}

function isProtectedSession(options: PruneModelTrafficDumpOptions, path: string): boolean {
  return activeSessionDirectories.has(path) || options.isProtected?.(path) === true || options.currentSessionDirectory === path
    || options.protectedSessionDirectories?.includes(path) === true;
}

function readManifest(directory: string): ManifestSnapshot | undefined {
  const path = join(directory, "manifest.json");
  let before: Stats;
  try { before = lstatSync(path); } catch (error) { if (missing(error)) return undefined; throw error; }
  if (!before.isFile() || before.size > maximumManifestBytes) throw new Error("Traffic dump maintenance manifest type or size invalid");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) throw new Error("Traffic dump maintenance manifest changed");
    const buffer = Buffer.alloc(maximumManifestBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximumManifestBytes || !sameFile(opened, fstatSync(descriptor)) || !sameFile(opened, lstatSync(path))) {
      throw new Error("Traffic dump maintenance manifest changed or exceeds read limit");
    }
    return { manifest: parseManifest(buffer.subarray(0, length).toString("utf8")), metadata: opened };
  } finally { closeSync(descriptor); }
}

function directoryStats(directory: string, scan: { entries: number }, depth = 0): { lastModifiedAtMs: number; size: number } {
  if (depth > 16) throw new Error("Traffic dump maintenance depth limit exceeded");
  const identity = inspectPrivateDirectoryAccessSync(directory);
  let lastModifiedAtMs = lstatSync(directory).mtimeMs;
  let size = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    countScannedEntry(scan);
    assertDirectoryIdentitySync(directory, identity);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = directoryStats(path, scan, depth + 1);
      lastModifiedAtMs = Math.max(lastModifiedAtMs, child.lastModifiedAtMs);
      size += child.size;
      continue;
    }
    const status = lstatSync(path);
    if (!status.isFile()) throw new Error("Traffic dump maintenance entry type invalid");
    lastModifiedAtMs = Math.max(lastModifiedAtMs, status.mtimeMs);
    size += status.size;
  }
  assertDirectoryIdentitySync(directory, identity);
  return { lastModifiedAtMs, size };
}

async function readManifestAsync(directory: string, signal: AbortSignal): Promise<ManifestSnapshot | undefined> {
  let file: import("node:fs/promises").FileHandle | undefined;
  try {
    const path = join(directory, "manifest.json");
    const before = await fs.lstat(path);
    if (!before.isFile() || before.size > maximumManifestBytes) throw new Error("Traffic dump maintenance manifest type or size invalid");
    signal.throwIfAborted();
    file = await fs.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    signal.throwIfAborted();
    const status = await file.stat();
    if (!sameFile(before, status)) throw new Error("Traffic dump maintenance manifest changed");
    const buffer = Buffer.alloc(maximumManifestBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumManifestBytes || !sameFile(status, await file.stat()) || !sameFile(status, await fs.lstat(path))) {
      throw new Error("Traffic dump maintenance manifest changed or exceeds read limit");
    }
    signal.throwIfAborted();
    return { manifest: parseManifest(buffer.subarray(0, length).toString("utf8")), metadata: status };
  } catch (error) {
    signal.throwIfAborted();
    if (missing(error)) return undefined;
    throw error;
  } finally { await file?.close(); }
}

function countScannedEntry(scan: { entries: number }): void {
  if (++scan.entries > 20_000) throw new Error("Traffic dump maintenance entry limit exceeded");
}

async function directoryStatsAsync(directory: string, signal: AbortSignal, scan: { entries: number }, depth = 0): Promise<{ lastModifiedAtMs: number; size: number }> {
  signal.throwIfAborted();
  if (depth > 16) throw new Error("Traffic dump maintenance depth limit exceeded");
  const identity = await inspectPrivateDirectoryAccess(directory, { signal });
  let lastModifiedAtMs = (await fs.lstat(directory)).mtimeMs;
  let size = 0;
  for await (const entry of await fs.opendir(directory)) {
    signal.throwIfAborted();
    countScannedEntry(scan);
    await assertDirectoryIdentity(directory, identity, signal);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await directoryStatsAsync(path, signal, scan, depth + 1);
      lastModifiedAtMs = Math.max(lastModifiedAtMs, child.lastModifiedAtMs); size += child.size;
    } else {
      const status = await fs.lstat(path);
      if (!status.isFile()) throw new Error("Traffic dump maintenance entry type invalid");
      lastModifiedAtMs = Math.max(lastModifiedAtMs, status.mtimeMs); size += status.size;
    }
  }
  await assertDirectoryIdentity(directory, identity, signal);
  return { lastModifiedAtMs, size };
}
