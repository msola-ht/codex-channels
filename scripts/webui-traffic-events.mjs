import { lstatSync, readdirSync, watch } from "node:fs";
import { dirname, basename, join } from "node:path";

/** File notifications carry no paths or content. Readers remain the source of truth. */
export function watchTrafficChanges(directory, scope, signal, send) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let watcher;
    let parent;
    let identity;
    let pending;
    let heartbeat;
    let stopped = false;
    const batches = new Map();
    const clearBatches = () => {
      for (const batch of batches.values()) batch.watcher.close();
      batches.clear();
    };
    const close = error => {
      if (stopped) return;
      stopped = true;
      clearTimeout(pending);
      clearInterval(heartbeat);
      watcher?.close();
      parent?.close();
      clearBatches();
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => close();
    const emit = type => {
      if (stopped) return;
      try { send(type); } catch (error) { close(error); }
    };
    const changed = () => {
      if (stopped || pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        emit("changed");
      }, 100);
    };
    const syncBatch = name => {
      if (!matchesTrafficChange(name, scope)) return;
      const path = join(directory, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      const next = stat?.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : undefined;
      const previous = batches.get(name);
      if (previous?.identity === next) return;
      previous?.watcher.close();
      batches.delete(name);
      if (next !== undefined) {
        try {
          // V2 stores files directly under each batch. Never recurse into payloads or links.
          const batchWatcher = watch(path, (_event, filename) => {
            if (filename === null || matchesTrafficChange(`${name}/${filename}`, scope)) changed();
          });
          batchWatcher.on("error", close);
          batches.set(name, { identity: next, watcher: batchWatcher });
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      changed();
    };
    const syncBatches = () => {
      const entries = readdirSync(directory, { withFileTypes: true });
      const names = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
      for (const name of new Set([...names, ...batches.keys()])) syncBatch(name);
    };
    const attach = () => {
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Invalid traffic directory");
      const next = stat ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : undefined;
      if (next === identity) return;
      watcher?.close();
      watcher = undefined;
      clearBatches();
      identity = next;
      if (stat) {
        watcher = watch(directory, (_event, filename) => {
          try {
            if (filename === null) { syncBatches(); changed(); }
            else syncBatch(filename.toString());
          } catch (error) { if (error.code !== "ENOENT") close(error); }
        });
        watcher.on("error", close);
        syncBatches();
      }
      changed();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      // Observe creation/replacement too; a page may open before the first dump exists.
      parent = watch(dirname(directory), (_event, filename) => {
        if (filename !== null && filename.toString() !== basename(directory)) return;
        try { attach(); } catch (error) { close(error); }
      });
      parent.on("error", close);
      attach();
      changed(); // Establish the subscription before asking the client for a snapshot.
      heartbeat = setInterval(() => emit("heartbeat"), 15_000);
      if (signal.aborted) abort();
    } catch (error) { close(error); }
  });
}

export function matchesTrafficChange(filename, { label, session, detail }) {
  if (filename === null) return true;
  const parts = filename.toString().split(/[\\/]/u);
  if (parts.length > 2) return false;
  const [batch, file] = parts;
  if (label !== undefined && session !== undefined && batch !== `${label}-${session}`) return false;
  if (label !== undefined && session === undefined && !batch.startsWith(`${label}-`)) return false;
  if (label === undefined && session !== undefined && !batch.endsWith(`-${session}`)) return false;
  return file === undefined || file === "manifest.json" || file === "interactions.jsonl"
    || (detail && /^(?:trace-[1-9]\d*\.jsonl|payload-[1-9]\d*\.bin)$/u.test(file));
}
