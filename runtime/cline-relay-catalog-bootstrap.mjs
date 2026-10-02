import { join } from "node:path";
import { providerStorageRoot } from "./connect-home.mjs";
import { withPrivateFileLock } from "./private-file-lock.mjs";
import { readClineRelayCatalog } from "./cline-relay-catalog.mjs";
import { downloadClineRelayCatalog, saveClineRelayCatalog } from "./cline-relay-catalog-update.mjs";

/** One missing-file attempt per owner lifetime; existing or malformed files require explicit updates. */
export function createClineRelayCatalogBootstrap(environment, { ready, failed }) {
  const controller = new AbortController();
  let attempted = false;
  let task;
  let closed = false;
  return {
    ensure() {
      if (closed || attempted || readClineRelayCatalog(environment).status !== "missing") return;
      attempted = true;
      const signal = globalThis.AbortSignal.any([controller.signal, globalThis.AbortSignal.timeout(25_000)]);
      task = (async () => {
        const catalog = await downloadClineRelayCatalog(environment, signal);
        signal.throwIfAborted();
        await withPrivateFileLock(join(providerStorageRoot(environment), ".management-transaction"), () => {
          signal.throwIfAborted();
          // An explicit update or another service may have completed while downloading.
          if (readClineRelayCatalog(environment).status === "missing") saveClineRelayCatalog(catalog, environment);
        });
        if (!closed) await ready();
      })().catch(() => { if (!closed) failed(); });
    },
    async close() {
      closed = true; controller.abort();
      let timer;
      try { await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(timer); }
    },
  };
}
