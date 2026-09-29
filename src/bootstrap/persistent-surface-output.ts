import { randomUUID } from "node:crypto";
import { DeliveryCoordinator, DeliveryJournal, DeliveryError } from "../delivery/index.js";
import type { ConversationTarget, OutputEvent } from "../conversation-core/index.js";
import { conversationTargetKey, surfaceAccountKey } from "../conversation-core/index.js";
import { mayReleaseUncertainOutputBarrier, decodePersistentOutput, snapshotPersistentOutput, withPersistentOutputImage, withPersistentDeliveryDiagnostics, type DeliveryCheckpoint } from "../surfaces/index.js";

export interface PersistentSurfaceOutputOptions {
  directory: string;
  owner(event: OutputEvent): string;
  authorized(event: OutputEvent, owner: string): boolean;
  accounts(): string[];
  deliver(event: OutputEvent, signal: AbortSignal, checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized: () => boolean, liveOrder?: number): Promise<void>;
  fault(code: string, account?: string, persistentDeliveryId?: string): void;
  changed?(): void;
  workerUrl?: URL;
}

export class PersistentSurfaceOutput {
  private readonly coordinator: DeliveryCoordinator;
  private readonly journal: DeliveryJournal;
  private readonly preparing = new Set<Promise<void>>();
  private readonly preparingConversations = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private pendingBytes = 0;
  private readonly liveOrders = new Map<string, number>();
  private closed = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly options: PersistentSurfaceOutputOptions) {
    this.journal = new DeliveryJournal(options.directory, options.workerUrl ? { workerUrl: options.workerUrl } : {});
    this.coordinator = new DeliveryCoordinator(this.journal, {
      accounts: () => options.accounts(),
      mayReleaseUncertainBarrier: (record) => {
        const payload = decodePersistentOutput(record.payload);
        return mayReleaseUncertainOutputBarrier(payload.event, payload.image !== undefined);
      },
      authorized: (record) => {
        const payload = decodePersistentOutput(record.payload);
        return options.authorized(payload.event, payload.owner);
      },
      deliver: async (record, signal) => {
        const liveOrder = this.liveOrders.get(record.id);
        this.liveOrders.delete(record.id);
        const payload = decodePersistentOutput(record.payload);
        if (!options.authorized(payload.event, payload.owner)) throw new Error("投递授权已变化");
        await withPersistentDeliveryDiagnostics(record.id, () => withPersistentOutputImage(payload, options.directory, (event) => options.deliver(event, signal, async (checkpoint) => {
          if (!(await this.journal.checkpoint(record.id, checkpoint))) throw new DeliveryError("storage");
          if (checkpoint.state === "started") {
            signal.throwIfAborted();
            if (!options.authorized(payload.event, payload.owner)) throw new Error("投递授权已变化");
          }
        }, () => options.authorized(payload.event, payload.owner), liveOrder)));
      },
      fault: (code, account, id) => options.fault(code, account, id),
      changed: () => this.notifyIdleWaiters(),
    });
  }

  start(): Promise<void> { return this.coordinator.start(); }
  wake(): void { this.coordinator.wake(); }
  acceptsExecution(target: ConversationTarget): boolean {
    return this.executionBlockReason(target) === undefined;
  }
  executionBlockReason(target: ConversationTarget): "unavailable" | "global-capacity" | "account-capacity" | undefined {
    return this.coordinator.executionBlockReason(surfaceAccountKey(target.surface, target.accountId));
  }
  waitForIdle(target: ConversationTarget, signal: AbortSignal): Promise<void> {
    const key = conversationTargetKey(target);
    if (this.idleWaiters.size >= 100) return Promise.reject(new Error("投递顺序等待容量已满"));
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (!this.closed && !signal.aborted && (this.preparingConversations.has(key) || this.coordinator.hasOutstanding(key))) return;
        this.idleWaiters.delete(check);
        signal.removeEventListener("abort", check);
        if (this.closed || signal.aborted) reject(new Error("投递顺序等待已取消"));
        else resolve();
      };
      this.idleWaiters.add(check);
      signal.addEventListener("abort", check, { once: true });
      check();
    });
  }
  hasOutstanding(event: OutputEvent): boolean {
    const key = conversationTargetKey(event.target);
    return this.preparingConversations.has(key) || this.coordinator.hasOutstanding(key);
  }

  accept(event: OutputEvent, liveOrder?: number): void {
    const account = surfaceAccountKey(event.target.surface, event.target.accountId);
    if (this.closed) return;
    let encoded: string;
    let owner: string;
    try {
      checkPayloadBudget(event);
      encoded = JSON.stringify(event);
      owner = this.options.owner(event);
      if (Buffer.byteLength(encoded) + Buffer.byteLength(owner) > 4 * 1024 * 1024) throw new Error("输出过大");
    } catch { this.options.fault("record-too-large", account); return; }
    // Images reserve their maximum accepted journal payload before starting any asynchronous read.
    const bytes = event.type === "operation.updated" && event.operation.imagePath ? 4 * 1024 * 1024
      : Buffer.byteLength(encoded) + Buffer.byteLength(JSON.stringify(owner)) + 64;
    if (this.preparing.size >= 128 || this.pendingBytes + bytes > 8 * 1024 * 1024) {
      this.options.fault("mailbox-full", account);
      return;
    }
    this.pendingBytes += bytes;
    const conversation = conversationTargetKey(event.target);
    this.preparingConversations.set(conversation, (this.preparingConversations.get(conversation) ?? 0) + 1);
    const snapshot = JSON.parse(encoded) as OutputEvent;
    const previous = this.tails.get(conversation) ?? Promise.resolve();
    const id = randomUUID();
    let submitted = false;
    if (liveOrder !== undefined) this.liveOrders.set(id, liveOrder);
    const task = previous.then(async () => {
      const payload = await snapshotPersistentOutput(snapshot, owner);
      if (this.closed && this.closeExpired) throw new Error("投递箱快照关闭期限已结束");
      submitted = await this.coordinator.submit({ id, account, conversation, payload: JSON.stringify(payload) });
    }).catch(() => this.options.fault("snapshot-failed", account)).finally(() => {
      if (!submitted) this.liveOrders.delete(id);
      this.pendingBytes -= bytes;
      this.preparing.delete(task);
      const count = (this.preparingConversations.get(conversation) ?? 1) - 1;
      if (count <= 0) this.preparingConversations.delete(conversation);
      else this.preparingConversations.set(conversation, count);
      if (this.tails.get(conversation) === task) this.tails.delete(conversation);
      this.notifyIdleWaiters();
    });
    this.preparing.add(task);
    this.tails.set(conversation, task);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.notifyIdleWaiters();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(this.preparing),
        new Promise<void>((resolve) => { timer = setTimeout(() => {
          this.closeExpired = true;
          this.options.fault("snapshot-timeout");
          resolve();
        }, 5_000); }),
      ]);
    } finally { clearTimeout(timer); await this.coordinator.close(); this.liveOrders.clear(); }
  }

  private closeExpired = false;
  private notifyIdleWaiters(): void {
    for (const check of [...this.idleWaiters]) check();
    this.options.changed?.();
  }
}

function checkPayloadBudget(value: unknown): void {
  let bytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32 || bytes > 4 * 1024 * 1024) throw new Error("输出过大");
    if (typeof item === "string") bytes += Buffer.byteLength(item);
    else if (Array.isArray(item)) {
      if (item.length > 20_000) throw new Error("输出过大");
      for (const child of item) visit(child, depth + 1);
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) { bytes += key.length; visit(child, depth + 1); }
    } else bytes += 8;
  };
  visit(value, 0);
  if (bytes > 4 * 1024 * 1024) throw new Error("输出过大");
}
