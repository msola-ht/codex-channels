import { readPrivateConfigFile } from "./private-file.mjs";
import { clinePassProviderDefinition, isManagedProviderModelValid } from "./model-provider-definitions.mjs";

/** Re-read only the shared Codex CLP catalogue before each outbound request. */
export class ClinePassModelGuard {
  #controller = new AbortController();
  #pending = new Set();

  constructor(path) { this.path = path; }

  async isEnabled(model, signal) {
    if (this.#controller.signal.aborted || this.#pending.size >= 16) {
      throw new Error("CLP 模型目录复核不可用");
    }
    const signals = [this.#controller.signal, globalThis.AbortSignal.timeout(15_000)];
    if (signal) signals.push(signal);
    const operationSignal = globalThis.AbortSignal.any(signals);
    operationSignal.throwIfAborted();
    const operation = readPrivateConfigFile(this.path, { signal: operationSignal, maximumBytes: 2_097_152 });
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
    const catalog = JSON.parse(content);
    if (!Array.isArray(catalog?.models) || !catalog.models.length) throw new Error("CLP 模型目录无效");
    const enabled = new Set();
    for (const entry of catalog.models) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || !isManagedProviderModelValid(clinePassProviderDefinition, entry.slug) || enabled.has(entry.slug)) {
        throw new Error("CLP 模型目录无效");
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
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("CLP 模型目录复核关闭超时")), 5_000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
}
