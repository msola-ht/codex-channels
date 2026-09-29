import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRelayMetricAuthorization, RelayMetricsComposition } from "../src/bootstrap/relay-metrics-composition.js";
import { sendRelayMetrics, type RelayMetric } from "../src/provider-proxy/index.js";

const control = vi.hoisted(() => ({ delay: 350, workers: 0 }));
vi.mock("node:worker_threads", async () => {
  const original = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  return { ...original, Worker: class extends original.Worker {
    constructor() {
      control.workers++;
      super(new URL(`data:text/javascript,${encodeURIComponent(`import {parentPort} from 'node:worker_threads';
        parentPort.on('message',()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${control.delay});
        parentPort.postMessage({ok:true,providers:['clp-a'],callers:[{caller_id:'a',key_id:'a',provider:'clp-a',credential_generation:1}]});});`)}`));
    }
  } };
});
const sample: RelayMetric = { source: "relay", threadId: null, turnId: null, relayRequestId: "7d40d091-8c74-4dcf-9e40-71531f3f1a98",
  callerId: "a", keyId: "a", credentialGeneration: 1, provider: "clp-a", requestModel: "fixture/model", responseFormat: "json",
  status: "completed", deliveryStatus: "finished", requestStartedAtMs: 1, responseCompletedAtMs: 2, totalDurationMs: 1 };
afterEach(() => { control.delay = 350; control.workers = 0; });

it("isolates synchronous identity I/O from the Gateway heartbeat", async () => {
  const authorize = createRelayMetricAuthorization("fixture", {});
  try {
    const start = performance.now();
    const heartbeat = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 10));
    const pending = authorize(sample);
    expect(await heartbeat).toBeLessThan(200);
    expect(await pending).toBeUndefined();
    expect(control.workers).toBe(1);
  } finally { await authorize.close(); }
});
it("bounds retained checks and terminates a hung identity reader", async () => {
  control.delay = 2000;
  const authorize = createRelayMetricAuthorization("fixture", {});
  try {
    const pending = Array.from({ length: 8 }, () => authorize(sample));
    expect(await authorize(sample)).toBe("queue_full");
    await new Promise(resolve => setTimeout(resolve, 30));
    await authorize.close();
    expect((await Promise.all(pending)).every(value => value !== undefined)).toBe(true);
    expect(await authorize(sample)).toBe("closing");
    expect(control.workers).toBe(1);
  } finally { await authorize.close(); }
});
it("rejects a slow worker at its deadline without blocking the event loop", async () => {
  control.delay = 2000;
  const authorize = createRelayMetricAuthorization("fixture", {});
  try {
    const start = performance.now();
    expect(await authorize(sample)).toBe("invalid_sample");
    expect(performance.now() - start).toBeLessThan(1500);
  } finally { await authorize.close(); }
});
it.each(["disconnect", "close"])("never enqueues a late authorization after %s", async action => {
  const root = mkdtempSync(join(tmpdir(), "relay-auth-")); const path = join(root, "metrics.sock");
  let resolve!: () => void; let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const wait = new Promise<undefined>(done => { resolve = () => done(undefined); });
  const enqueue = vi.fn();
  const receiver = new RelayMetricsComposition({ path, writer: { enqueue, close: async () => {} },
    authorize: async () => { entered(); return wait; } });
  const controller = new AbortController();
  try {
    await receiver.apply(true);
    const sent = sendRelayMetrics(path, { version: 1, providerId: sample.provider, relayRequestId: sample.relayRequestId, sample }, controller.signal).catch(() => undefined);
    await started;
    if (action === "close") await receiver.close(); else controller.abort();
    await sent; await new Promise(done => setTimeout(done, 20)); resolve();
    await new Promise(done => setTimeout(done, 20)); expect(enqueue).not.toHaveBeenCalled();
  } finally { resolve?.(); await receiver.close(); rmSync(root, { recursive: true, force: true }); }
});
