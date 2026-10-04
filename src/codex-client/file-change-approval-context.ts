import type { FileApprovalChange } from "../approval/index.js";
import type { RpcNotification } from "./json-rpc.js";

interface Entry {
  threadId: string;
  turnId: string;
  changes: FileApprovalChange[] | null;
}

/** Bounded, connection-local presentation data; never a source of authorization. */
export class FileChangeApprovalContext {
  private readonly entries = new Map<string, Entry>();

  clear(): void {
    this.entries.clear();
  }

  clearThread(threadId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.threadId === threadId) this.entries.delete(key);
    }
  }

  get(threadId: string, turnId: string, itemId: string): FileApprovalChange[] | null | undefined {
    const changes = this.entries.get(JSON.stringify([threadId, turnId, itemId]))?.changes;
    return changes == null ? changes : changes.map(change => ({ ...change }));
  }

  observe(notification: RpcNotification): void {
    const params = record(notification.params);
    const threadId = params?.threadId;
    if (typeof threadId !== "string") return;
    if (["thread/closed", "thread/archived", "thread/deleted", "thread/reverted"].includes(notification.method)) {
      this.clearThread(threadId);
      return;
    }
    if (notification.method === "turn/completed") {
      const turnId = record(params?.turn)?.id;
      for (const [key, entry] of this.entries) {
        if (entry.threadId === threadId && entry.turnId === turnId) this.entries.delete(key);
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") return;
    const item = record(params?.item);
    const turnId = params?.turnId;
    if (typeof turnId !== "string" || typeof item?.id !== "string") return;
    const key = JSON.stringify([threadId, turnId, item.id]);
    this.entries.delete(key);
    if (notification.method === "item/completed" || item.type !== "fileChange" || item.status !== "inProgress") return;
    const changes = parseChanges(item.changes) ?? null;
    if (this.entries.size >= 128) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { threadId, turnId, changes });
  }
}

function parseChanges(value: unknown): FileApprovalChange[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined;
  const changes: FileApprovalChange[] = [];
  let bytes = 0;
  for (const raw of value) {
    const change = record(raw);
    const kind = record(change?.kind);
    if (typeof change?.path !== "string" || !change.path || !kind
      || (kind.type !== "add" && kind.type !== "delete" && kind.type !== "update")) return undefined;
    if (kind.type === "update" && kind.move_path !== null && typeof kind.move_path !== "string") return undefined;
    const movePath = kind.type === "update" && typeof kind.move_path === "string" ? kind.move_path : undefined;
    if (movePath === "") return undefined;
    bytes += Buffer.byteLength(change.path, "utf8") + Buffer.byteLength(movePath ?? "", "utf8");
    if (bytes > 12_000) return undefined;
    changes.push({ path: change.path, kind: kind.type, ...(movePath ? { movePath } : {}) });
  }
  return changes;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
