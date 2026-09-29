import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayMetricsSender, type RelayMetric } from "../src/model-relay/index.js";
import { RelayMetricsServer, sendRelayMetrics } from "../src/provider-proxy/index.js";
import { createPrivateIpcConnection } from "../runtime/private-ipc.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sample: RelayMetric = { source: "relay", threadId: null, turnId: null, relayRequestId: "7d40d091-8c74-4dcf-9e40-71531f3f1a98",
  callerId: "a", keyId: "a", credentialGeneration: 1, provider: "clp-a", requestModel: "fixture/model", responseFormat: "json",
  status: "completed", deliveryStatus: "finished", requestStartedAtMs: 1, responseCompletedAtMs: 2, totalDurationMs: 1 };
afterEach(() => vi.useRealTimers());
describe("Relay metric confirmation semantics", () => {
  it("validates the actual private IPC envelope, refuses oversized/slow frames and never invokes the writer for them", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-ipc-")); const path = join(root, "metrics.sock");
    const receive = vi.fn(() => undefined); const server = new RelayMetricsServer(path, receive);
    await server.start();
    const exchange = async (value: unknown): Promise<string> => new Promise((resolve, reject) => {
      const socket = createPrivateIpcConnection(path); let text = "";
      socket.on("error", reject); socket.on("data", chunk => { text += chunk.toString(); });
      socket.once("close", () => resolve(text)); socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    });
    const envelope = { version: 1 as const, providerId: sample.provider, relayRequestId: sample.relayRequestId, sample };
    try {
      expect(await sendRelayMetrics(path, envelope, AbortSignal.timeout(2000))).toMatchObject({ result: "accepted" });
      expect(JSON.parse(await exchange({ ...envelope, version: 0 })) as unknown).toMatchObject({ result: "rejected", reason: "unsupported_version" });
      expect(JSON.parse(await exchange({ ...envelope, sample: { ...sample, threadId: "forged" } })) as unknown).toMatchObject({ result: "rejected", reason: "invalid_sample" });
      expect(JSON.parse(await exchange({ ...envelope, providerId: "clp-other" })) as unknown).toMatchObject({ result: "rejected", reason: "invalid_sample" });
      expect(JSON.parse(await exchange({ ...envelope, sample: { ...sample, responseModel: "unsafe\nmodel" } })) as unknown).toMatchObject({ result: "rejected", reason: "invalid_sample" });
      expect(JSON.parse(await exchange({ ...envelope, sample: { ...sample, errorCode: "unsafe@error" } })) as unknown).toMatchObject({ result: "rejected", reason: "invalid_sample" });
      expect(await exchange({ ...envelope, padding: "x".repeat(33 * 1024) })).toBe("");
      const started = Date.now();
      await new Promise<void>((resolve, reject) => {
        const socket = createPrivateIpcConnection(path); socket.on("error", reject);
        socket.once("connect", () => socket.write("{")); socket.once("close", resolve);
      });
      expect(Date.now() - started).toBeLessThan(2500);
      expect(receive).toHaveBeenCalledTimes(1);
    } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    [{ version: 1, relayRequestId: sample.relayRequestId, result: "accepted" }, "accepted"],
    [{ version: 1, relayRequestId: sample.relayRequestId, result: "rejected", reason: "queue_full" }, "rejected"],
    ["ok", "unconfirmed"],
    [{ version: 0, relayRequestId: sample.relayRequestId, result: "accepted" }, "unconfirmed"],
    [{ version: 1, relayRequestId: "wrong", result: "accepted" }, "unconfirmed"],
    [{ version: 1, relayRequestId: sample.relayRequestId, result: "rejected", reason: "untrusted" }, "unconfirmed"],
  ] as const)("requires version, correlation and controlled result", async (response, outcome) => {
    const send = vi.fn(async () => response); const sender = new RelayMetricsSender(send);
    sender.enqueue(sample); await sender.close();
    expect(sender.diagnostics()[outcome]).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not call an unconfirmed timeout lost or retry it, and bounds cancellation-ignoring adapters", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<unknown>(() => {})); const sender = new RelayMetricsSender(send);
    for (let index = 0; index < 257; index++) sender.enqueue({ ...sample, relayRequestId: String(index) });
    await vi.advanceTimersByTimeAsync(1001);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sender.diagnostics()).toMatchObject({ active: 2, pending: 254, unconfirmed: 2, local_dropped: 1 });
    const closed = sender.close(); await vi.advanceTimersByTimeAsync(1001); await closed;
    expect(sender.diagnostics()).toMatchObject({ unconfirmed: 2, local_dropped: 255, pending: 0 });
  });
  it("distinguishes rejection and missing confirmation after receiver acceptance", async () => {
    const sender = new RelayMetricsSender(async () => { throw new Error("ack lost after enqueue"); });
    sender.enqueue(sample); await sender.close();
    expect(sender.diagnostics()).toMatchObject({ unconfirmed: 1, rejected: 0, local_dropped: 0, accepted: 0 });
    sender.enqueue(sample); expect(sender.diagnostics().local_dropped).toBe(1);
  });
});
