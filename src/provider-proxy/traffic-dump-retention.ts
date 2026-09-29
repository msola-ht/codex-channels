import {
  existsSync,
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

export interface PruneModelTrafficDumpOptions {
  /** 转储根目录。 */
  directory: string;
  /** 只清理指定 Provider；省略时清理自有 V2 Provider；Relay 由独立 owner 显式清理。 */
  label?: string;
  /** 历史 session 的最长保留天数；`0` 关闭按时间清理。 */
  retentionDays: number;
  maximumBytes?: number;
  /** 当前写入目录；清理时始终保留。 */
  currentSessionDirectory?: string;
  /** 仍有调用或文件流归属的目录；清理时始终保留。 */
  protectedSessionDirectories?: readonly string[];
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
    if (manifest?.version !== 2 || (options.label === undefined && manifest.label === "relay.chat") || (options.label !== undefined && manifest.label !== options.label)) {
      continue;
    }
    const sessions = byLabel.get(manifest.label) ?? [];
    const stats = directoryStats(path);
    sessions.push({
      createdAtMs: manifest.createdAtMs,
      lastActivityAtMs: Math.max(manifest.createdAtMs, stats.lastModifiedAtMs),
      path,
      size: stats.size,
    });
    byLabel.set(manifest.label, sessions);
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
  const entries = await fs.readdir(options.directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const byLabel = new Map<string, RetainedSession[]>();
  for (const entry of entries) {
    signal.throwIfAborted();
    if (!entry.isDirectory()) continue;
    const path = join(options.directory, entry.name);
    const manifest = await fs.readFile(join(path, "manifest.json"), "utf8").then(parseManifest, () => undefined);
    if (manifest?.version !== 2 || (options.label === undefined && manifest.label === "relay.chat")
      || (options.label !== undefined && manifest.label !== options.label)) continue;
    const stats = await directoryStatsAsync(path, signal);
    const sessions = byLabel.get(manifest.label) ?? [];
    sessions.push({ path, createdAtMs: manifest.createdAtMs, lastActivityAtMs: Math.max(manifest.createdAtMs, stats.lastModifiedAtMs), size: stats.size });
    byLabel.set(manifest.label, sessions);
  }
  const result = planRetention(options, byLabel);
  for (const session of result.remove) {
    signal.throwIfAborted();
    // The owner may have created a writer session after the plan was computed.
    if (options.protectedSessionDirectories?.includes(session.path)) { result.bytes += session.size; continue; }
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
      const protectedSession = protectedDirectories.has(session.path);
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

async function directoryStatsAsync(directory: string, signal: AbortSignal): Promise<{ lastModifiedAtMs: number; size: number }> {
  signal.throwIfAborted();
  let lastModifiedAtMs = (await fs.stat(directory)).mtimeMs;
  let size = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    signal.throwIfAborted();
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await directoryStatsAsync(path, signal);
      lastModifiedAtMs = Math.max(lastModifiedAtMs, child.lastModifiedAtMs); size += child.size;
    } else {
      const status = await fs.stat(path);
      lastModifiedAtMs = Math.max(lastModifiedAtMs, status.mtimeMs); size += status.size;
    }
  }
  return { lastModifiedAtMs, size };
}
