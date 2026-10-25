import type { OutputEvent } from "../conversation-core/index.js";
import { DeliveryReceipt } from "./delivery-receipt.js";
import { supersedesSurfaceSnapshot } from "./delivery-policy.js";

/** Owns live transient sends through timers, queues and platform calls; never a replay store. */
export class SnapshotDelivery {
  private readonly active = new Set<{ event: OutputEvent; controller: AbortController }>();

  observe(event: OutputEvent): void {
    for (const entry of this.active) {
      // The owner may already hold a newer terminal retry snapshot. Let its in-flight creation
      // settle so that the terminal update can reuse the verified platform message handle.
      // The owner's snapshot controller still cancels a latest-state entry that is obsolete.
      if (entry.event.type === "turn.retry") continue;
      if (supersedesSurfaceSnapshot(event, entry.event)) entry.controller.abort();
    }
  }

  async run(event: OutputEvent, signal: AbortSignal, authorized: () => boolean, call: () => void, supersedable = true): Promise<void> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const entry = { event, controller };
    if (supersedable) this.active.add(entry);
    const receipt = new DeliveryReceipt((checkpoint) => {
      if (checkpoint.state === "started" && !authorized()) throw new Error("状态展示授权已变化");
      return Promise.resolve();
    }, AbortSignal.any([signal, controller.signal]), true, () => {
      if (!authorized()) throw new Error("状态展示授权已变化");
    });
    try {
      try {
        if (!authorized()) throw new Error("状态展示授权已变化");
        receipt.run(call);
      } catch (error) { receipt.fail(error); }
      finally { receipt.release(); }
      await receipt.done;
    } finally { this.active.delete(entry); }
  }
}
