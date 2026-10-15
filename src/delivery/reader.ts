import { Worker } from "node:worker_threads";
import { serialize } from "node:v8";
import { z } from "zod";
import { DeliveryError, type DeliveryQueueEntry, type DeliveryQueueSnapshot, type DeliveryState } from "./types.js";
import type { DeliveryReadCommand, DeliveryReadFailure, DeliveryReadItem, DeliveryReadReply, DeliveryReadResult } from "./reader-protocol.js";

export type { DeliveryReadFailure } from "./reader-protocol.js";
export interface DeliveryReadOptions { signal?: AbortSignal }
export class DeliveryReadError extends DeliveryError {
  constructor(readonly failure: DeliveryReadFailure) {
    super(failure.reason === "overload" ? "mailbox-full" : failure.reason === "closed" ? "closed" : "storage");
    this.name = "DeliveryReadError";
  }
}

// A slot remains owned until exit, including after a timed-out terminate().
const activeReaders = new Map<Worker, { exit: Promise<void>; cancel(): void }>();
let closingReaders = false;
let readersClosePromise: Promise<void> | undefined;
const idsSchema = z.array(z.string().min(1).max(4096)).min(1).max(50).refine(ids => new Set(ids).size === ids.length);
const queueSchema = z.strictObject({ before: z.number().int().nonnegative().safe().optional(),
  state: z.enum(["pending", "sending", "uncertain", "blocked"]).optional(), id: z.string().min(1).max(4096).optional() });

/** Stop admission and cancel all owned reads; an expired wait does not release ownership. */
export function closeDeliveryReaders(): Promise<void> {
  if (readersClosePromise) return readersClosePromise;
  closingReaders = true;
  for (const reader of activeReaders.values()) reader.cancel();
  readersClosePromise = (async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([waitForDeliveryReadersExit(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeliveryReadError({ phase: "shutdown", reason: "timeout", operation: "close" })), 2_000);
      })]);
    } finally { clearTimeout(timer); }
  })();
  return readersClosePromise;
}

/** Actual exit confirmation, including after a bounded close reported uncertainty. */
export async function waitForDeliveryReadersExit(): Promise<void> {
  await Promise.all([...activeReaders.values()].map(reader => reader.exit));
}

export async function readDeliveryQueue(directory: string, options: { before?: number; state?: DeliveryState; id?: string; signal?: AbortSignal } = {}): Promise<DeliveryQueueSnapshot> {
  const { signal, ...query } = options;
  queueSchema.parse(query);
  return read(directory, { type: "queue", options: query }, { ...(signal ? { signal } : {}) }) as Promise<DeliveryQueueSnapshot>;
}
export async function readDeliveryEntries(directory: string, ids: string[], options: DeliveryReadOptions = {}): Promise<Array<DeliveryQueueEntry | null>> {
  return read(directory, { type: "entries", ids: idsSchema.parse(ids) }, options) as Promise<Array<DeliveryQueueEntry | null>>;
}
export async function readDeliveryPayload(directory: string, id: string, options: DeliveryReadOptions = {}): Promise<DeliveryReadItem> {
  let item: DeliveryReadItem = null;
  await read(directory, { type: "payload", ids: idsSchema.parse([id]) }, options, value => { item = value; });
  return item;
}
export async function readDeliveryPayloads<T>(directory: string, ids: string[], project: (row: DeliveryQueueEntry, payload: string) => T, options: DeliveryReadOptions = {}): Promise<Array<T | null>> {
  const results: Array<T | null> = [];
  let bytes = 0;
  await read(directory, { type: "payloads", ids: idsSchema.parse(ids) }, options, value => {
    let result: T | null = null;
    try { if (value) result = project(value.row, value.payload); }
    catch { /* A malformed individual payload or failed projection remains null. */ }
    bytes += serialize(result).byteLength;
    if (bytes > 4 * 1024 * 1024) throw new DeliveryReadError({ phase: "request", reason: "overload", operation: "payloads" });
    results.push(result);
  });
  return results;
}

async function read(directory: string, command: DeliveryReadCommand, { signal }: DeliveryReadOptions, receive?: (value: DeliveryReadItem) => void): Promise<DeliveryReadResult> {
  const error = (phase: DeliveryReadFailure["phase"], reason: DeliveryReadFailure["reason"]) => new DeliveryReadError({ phase, reason, operation: command.type });
  if (closingReaders) throw error("startup", "closed");
  if (signal?.aborted) throw error("startup", "aborted");
  if (activeReaders.size >= 2) throw error("startup", "overload");
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  let worker: Worker;
  try { worker = new Worker(new URL("./reader-worker.js", import.meta.url), { workerData: { directory, command, cancellation } }); }
  catch { throw error("startup", "worker-error"); }
  let exited = false;
  const exit = new Promise<void>(resolve => worker.once("exit", () => { exited = true; activeReaders.delete(worker); resolve(); }));
  let cancelRead = () => { Atomics.store(cancellation, 0, 1); };
  activeReaders.set(worker, { exit, cancel: () => cancelRead() });
  let timer: NodeJS.Timeout | undefined;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  let failure: DeliveryReadError | undefined;
  let result: DeliveryReadResult = null;
  try {
    result = await new Promise<DeliveryReadResult>((resolve, reject) => {
      let ready = false;
      let nextIndex = 0;
      let requestDeadline = 0;
      const startupBudget = process.platform === "win32" ? 30_000 : 5_000;
      const startupDeadline = performance.now() + startupBudget;
      const arm = (phase: "startup" | "request", milliseconds: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => { Atomics.store(cancellation, 0, 1); reject(error(phase, "timeout")); }, milliseconds);
      };
      arm("startup", startupBudget);
      abort = () => { Atomics.store(cancellation, 0, 1); reject(error(ready ? "request" : "startup", "aborted")); };
      cancelRead = abort;
      worker.on("error", () => reject(error("worker", "worker-error")));
      worker.once("exit", () => reject(error("worker", "worker-exit")));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      worker.on("message", (reply: DeliveryReadReply) => {
        try {
          if (signal?.aborted) { abort?.(); return; }
          if (performance.now() >= (ready ? requestDeadline : startupDeadline)) throw error(ready ? "request" : "startup", "timeout");
          if (reply.type === "ready" && !ready) {
            ready = true;
            requestDeadline = performance.now() + 5_000;
            arm("request", 5_000);
            worker.postMessage({ type: "start" });
          } else if (reply.type === "item" && ready && receive && reply.index === nextIndex) {
            receive(reply.value);
            if (signal?.aborted || Atomics.load(cancellation, 0) !== 0) throw error("request", "aborted");
            if (performance.now() >= requestDeadline) throw error("request", "timeout");
            nextIndex += 1;
            worker.postMessage({ type: "ack", index: reply.index });
          } else if (reply.type === "result" && ready) {
            if ("ids" in command && receive && nextIndex !== command.ids.length) throw error("request", "message");
            resolve(reply.value);
          } else if (reply.type === "failure") reject(new DeliveryReadError(reply.failure));
          else throw error("request", "message");
        } catch (caught) { reject(caught instanceof DeliveryReadError ? caught : error("request", "message")); }
      });
    });
  } catch (caught) { failure = caught instanceof DeliveryReadError ? caught : error("request", "message"); }
  finally {
    Atomics.store(cancellation, 0, 1);
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    // Stop processing late bodies before attempting graceful shutdown.
    worker.removeAllListeners("message");
    try {
      if (!exited) worker.postMessage({ type: "close" });
      await Promise.race([exit, new Promise<never>((_, reject) => {
        shutdownTimer = setTimeout(() => reject(error("shutdown", "timeout")), 2_000);
      })]);
    } catch {
      // Windows ACL children retain this owner until their cleanup is confirmed.
      if (process.platform !== "win32") {
        worker.unref();
        void worker.terminate().catch(() => {});
      }
      failure = error("shutdown", "timeout");
    } finally { clearTimeout(shutdownTimer); }
  }
  if (failure) throw failure;
  return result;
}
