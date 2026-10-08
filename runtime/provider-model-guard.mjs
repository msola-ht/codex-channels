import { readPrivateConfigFile } from "./private-file.mjs";
import { lstat } from "node:fs/promises";

/** Re-read the provider's enabled Codex catalogue before each outbound request. */
export class ProviderModelGuard {
  #controller = new AbortController();
  #pending = new Set();

  constructor(path, isModelValid, { parseCatalog = JSON.parse, blockedPaths = [] } = {}) {
    this.path = path;
    this.isModelValid = isModelValid;
    this.parseCatalog = parseCatalog;
    this.blockedPaths = [...blockedPaths];
  }

  async assertNoPendingWrite(signal) {
    for (const path of this.blockedPaths) {
      signal.throwIfAborted();
      try { await lstat(path); }
      catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      throw new Error("Provider 模型目录存在未完成事务");
    }
    signal.throwIfAborted();
  }

  async readCatalog(signal) {
    await this.assertNoPendingWrite(signal);
    const content = await readPrivateConfigFile(this.path, { signal, maximumBytes: 2_097_152 });
    await this.assertNoPendingWrite(signal);
    return content;
  }

  async isEnabled(model, signal) {
    if (this.#controller.signal.aborted || this.#pending.size >= 16) {
      throw new Error("Provider 模型目录复核不可用");
    }
    const signals = [this.#controller.signal, globalThis.AbortSignal.timeout(15_000)];
    if (signal) signals.push(signal);
    const operationSignal = globalThis.AbortSignal.any(signals);
    operationSignal.throwIfAborted();
    const operation = this.readCatalog(operationSignal);
    this.#pending.add(operation);
    // Cancellation ends the waiter, but a read keeps its slot until descriptor or
    // Windows child cleanup finishes. Cancelled uploads cannot grow the queue.
    const content = await new Promise((resolve, reject) => {
      const cancel = () => { operationSignal.removeEventListener("abort", cancel); reject(operationSignal.reason); };
      operationSignal.addEventListener("abort", cancel, { once: true });
      operation.then(value => {
        this.#pending.delete(operation);
        operationSignal.removeEventListener("abort", cancel);
        resolve(value);
      }, error => {
        this.#pending.delete(operation);
        operationSignal.removeEventListener("abort", cancel);
        reject(error);
      });
      if (operationSignal.aborted) cancel();
    });
    operationSignal.throwIfAborted();
    const catalog = this.parseCatalog(content);
    if (!Array.isArray(catalog?.models) || !catalog.models.length) throw new Error("Provider 模型目录无效");
    const enabled = new Set();
    for (const entry of catalog.models) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || !this.isModelValid(entry.slug) || enabled.has(entry.slug)) {
        throw new Error("Provider 模型目录无效");
      }
      enabled.add(entry.slug);
    }
    return enabled.has(model);
  }

  async close() {
    this.#controller.abort();
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...this.#pending]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Provider 模型目录复核关闭超时")), 5_000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
}
