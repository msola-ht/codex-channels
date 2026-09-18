import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export const modelTrafficDumpFileSizeLimitBytes = 64 * 1_048_576;
/** 同一 Provider 的历史完整 session 约保留 320 MiB；当前 session 不在写入中途删除。 */
const retainedBytesPerLabel = 5 * modelTrafficDumpFileSizeLimitBytes;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export interface PruneModelTrafficDumpOptions {
  /** 转储根目录。 */
  directory: string;
  /** 只清理指定 Provider；省略时清理目录中的全部 V2 Provider。 */
  label?: string;
  /** 历史 session 的最长保留天数；`0` 关闭按时间清理。 */
  retentionDays: number;
  /** 当前写入目录；清理时始终保留。 */
  currentSessionDirectory?: string;
  /** 仍有调用或文件流归属的目录；清理时始终保留。 */
  protectedSessionDirectories?: readonly string[];
}

/** 清理可识别的 V2 历史 session；未知目录与旧版文件保持不变。 */
export function pruneModelTrafficDumpSessions(options: PruneModelTrafficDumpOptions): void {
  if (!existsSync(options.directory)) return;
  const protectedDirectories = new Set(options.protectedSessionDirectories ?? []);
  if (options.currentSessionDirectory !== undefined) {
    protectedDirectories.add(options.currentSessionDirectory);
  }
  const byLabel = new Map<string, Array<{
    createdAtMs: number;
    lastActivityAtMs: number;
    path: string;
    size: number;
  }>>();
  for (const entry of readdirSync(options.directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(options.directory, entry.name);
    const manifest = readManifest(path);
    if (manifest?.version !== 2 || (options.label !== undefined && manifest.label !== options.label)) {
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
  const oldestRetainedAtMs = options.retentionDays === 0
    ? null
    : Date.now() - options.retentionDays * millisecondsPerDay;
  for (const sessions of byLabel.values()) {
    sessions.sort((left, right) => right.lastActivityAtMs - left.lastActivityAtMs
      || right.createdAtMs - left.createdAtMs);
    let retained = 0;
    for (const session of sessions) {
      const protectedSession = protectedDirectories.has(session.path);
      if (
        !protectedSession
        && oldestRetainedAtMs !== null
        && session.lastActivityAtMs < oldestRetainedAtMs
      ) {
        rmSync(session.path, { force: true, recursive: true });
        continue;
      }
      retained += session.size;
      if (protectedSession || retained <= retainedBytesPerLabel) continue;
      rmSync(session.path, { force: true, recursive: true });
    }
  }
}

function readManifest(directory: string): {
  createdAtMs: number;
  label: string;
  session: string;
  version: number;
} | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as {
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
