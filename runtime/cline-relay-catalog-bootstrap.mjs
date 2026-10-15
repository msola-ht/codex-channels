import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { providerStorageRoot } from "./connect-home.mjs";
import { withPrivateFileLock } from "./private-file-lock.mjs";
import { clineRelayCatalogPath } from "./cline-relay-catalog.mjs";
import { downloadClineRelayCatalog, saveClineRelayCatalog } from "./cline-relay-catalog-update.mjs";

/** One missing-file attempt per owner lifetime; existing or malformed files require explicit updates. */
export function createClineRelayCatalogBootstrap(environment, { ready, failed }) {
  const controller = new AbortController();
  let attempted = false;
  let task;
  let closed = false;
  return {
    ensure(status) {
      // Only the material worker projects current private-file state into this owner.
      if (closed || attempted || status !== "missing") return;
      attempted = true;
      const signal = globalThis.AbortSignal.any([controller.signal, globalThis.AbortSignal.timeout(25_000)]);
      task = (async () => {
        const catalog = await downloadClineRelayCatalog(environment, signal);
        signal.throwIfAborted();
        await withPrivateFileLock(join(providerStorageRoot(environment), ".management-transaction"), async () => {
          signal.throwIfAborted();
          // An explicit update or another service may have completed while downloading.
          // Existing files, including invalid/private-access failures, require an explicit update.
          try { await lstat(clineRelayCatalogPath(environment)); }
          catch (error) {
            signal.throwIfAborted();
            if (error?.code === "ENOENT") saveClineRelayCatalog(catalog, environment);
          }
          signal.throwIfAborted();
        });
        signal.throwIfAborted();
        if (!closed) await ready();
      })().catch(() => { if (!closed) failed(); });
    },
    async close() {
      closed = true; controller.abort();
      let timer;
      try { await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Relay catalog shutdown unconfirmed")), 2000);
      })]); }
      finally { clearTimeout(timer); }
    },
  };
}
