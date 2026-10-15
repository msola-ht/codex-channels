import {
  existsSync,
  constants,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";

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

type RetainedSession = { createdAtMs: number; lastActivityAtMs: number; path: string; size: number };

/** 清理可识别的 V2 历史 session；未知目录与旧版文件保持不变。 */
export function pruneModelTrafficDumpSessions(options: PruneModelTrafficDumpOptions): number {
  if (!existsSync(options.directory)) return 0;
  const byLabel = new Map<string, RetainedSession[]>();
  for (const entry of readdirSync(options.directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(options.directory, entry.name);
    const manifest = readManifest(path);
    if (manifest?.version !== 2 || (!options.label && !options.labels && ["relay.chat", "relay.responses"].includes(manifest.label)) || (options.label !== undefined && manifest.label !== options.label) || (options.labels !== undefined && !options.labels.includes(manifest.label))) {
      continue;
    }
    const sessions = byLabel.get(options.labels ? "combined" : manifest.label) ?? [];
    const stats = directoryStats(path);
    sessions.push({
      createdAtMs: manifest.createdAtMs,
      lastActivityAtMs: Math.max(manifest.createdAtMs, stats.lastModifiedAtMs),
      path,
      size: stats.size,
    });
    byLabel.set(options.labels ? "combined" : manifest.label, sessions);
  }
  const result = planRetention(options, byLabel);
  for (const session of result.remove) rmSync(session.path, { force: true, recursive: true });
  return result.bytes;
}

/** Async maintenance protects the writer's snapshot plus sessions created during the scan. */
export async function pruneModelTrafficDumpSessionsAsync(options: PruneModelTrafficDumpOptions & {
  onRemoved?: (bytes: number) => void;
}, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const directory = await fs.opendir(options.directory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!directory) return 0;
  const scan = { entries: 0 };
  const byLabel = new Map<string, RetainedSession[]>();
  for await (const entry of directory) {
    signal.throwIfAborted();
    countScannedEntry(scan);
    if (!entry.isDirectory()) continue;
    const path = join(options.directory, entry.name);
    const manifest = await readManifestAsync(path, signal);
    if (manifest?.version !== 2 || (!options.label && !options.labels && ["relay.chat", "relay.responses"].includes(manifest.label))
      || (options.label !== undefined && manifest.label !== options.label) || (options.labels !== undefined && !options.labels.includes(manifest.label))) continue;
    const stats = await directoryStatsAsync(path, signal, scan).catch((error: unknown) => {
      // Another maintenance owner may have removed an inactive session while this scan yielded.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) continue;
    const sessions = byLabel.get(options.labels ? "combined" : manifest.label) ?? [];
    sessions.push({ path, createdAtMs: manifest.createdAtMs, lastActivityAtMs: Math.max(manifest.createdAtMs, stats.lastModifiedAtMs), size: stats.size });
    byLabel.set(options.labels ? "combined" : manifest.label, sessions);
  }
  const result = planRetention(options, byLabel);
  for (const session of result.remove) {
    signal.throwIfAborted();
    // The owner may have created a writer session after the plan was computed.
    if (activeSessionDirectories.has(session.path) || options.isProtected?.(session.path) || options.currentSessionDirectory === session.path
      || options.protectedSessionDirectories?.includes(session.path)) { result.bytes += session.size; continue; }
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

function readManifest(directory: string): {
  createdAtMs: number;
  label: string;
  session: string;
  version: number;
} | undefined {
  try { return parseManifest(readFileSync(join(directory, "manifest.json"), "utf8")); } catch { return undefined; }
}

function parseManifest(text: string): { createdAtMs: number; label: string; session: string; version: number } | undefined {
  try {
    const value = JSON.parse(text) as {
      createdAtMs?: unknown;
      label?: unknown;
      session?: unknown;
      version?: unknown;
    };
    return typeof value.createdAtMs === "number"
      && typeof value.label === "string"
      && typeof value.session === "string"
      && typeof value.version === "number"
      ? value as { createdAtMs: number; label: string; session: string; version: number }
      : undefined;
  } catch {
    return undefined;
  }
}

function directoryStats(directory: string): { lastModifiedAtMs: number; size: number } {
  let lastModifiedAtMs = statSync(directory).mtimeMs;
  let size = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = directoryStats(path);
      lastModifiedAtMs = Math.max(lastModifiedAtMs, child.lastModifiedAtMs);
      size += child.size;
      continue;
    }
    const status = statSync(path);
    lastModifiedAtMs = Math.max(lastModifiedAtMs, status.mtimeMs);
    size += status.size;
  }
  return { lastModifiedAtMs, size };
}

async function readManifestAsync(directory: string, signal: AbortSignal): Promise<ReturnType<typeof parseManifest>> {
  let file: import("node:fs/promises").FileHandle | undefined;
  try {
    file = await fs.open(join(directory, "manifest.json"), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    signal.throwIfAborted();
    const status = await file.stat();
    if (!status.isFile() || status.size > 16_384) return undefined;
    return parseManifest(await file.readFile({ encoding: "utf8", signal }));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  } finally { await file?.close(); }
}

function countScannedEntry(scan: { entries: number }): void {
  if (++scan.entries > 20_000) throw new Error("Traffic dump maintenance entry limit exceeded");
}

async function directoryStatsAsync(directory: string, signal: AbortSignal, scan: { entries: number }, depth = 0): Promise<{ lastModifiedAtMs: number; size: number }> {
  signal.throwIfAborted();
  if (depth > 16) throw new Error("Traffic dump maintenance depth limit exceeded");
  let lastModifiedAtMs = (await fs.lstat(directory)).mtimeMs;
  let size = 0;
  for await (const entry of await fs.opendir(directory)) {
    signal.throwIfAborted();
    countScannedEntry(scan);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await directoryStatsAsync(path, signal, scan, depth + 1);
      lastModifiedAtMs = Math.max(lastModifiedAtMs, child.lastModifiedAtMs); size += child.size;
    } else {
      const status = await fs.lstat(path);
      lastModifiedAtMs = Math.max(lastModifiedAtMs, status.mtimeMs); size += status.size;
    }
  }
  return { lastModifiedAtMs, size };
}
