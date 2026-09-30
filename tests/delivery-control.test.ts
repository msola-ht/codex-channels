import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryControlServer, requestDeliveryResolution, deliveryControlSocketPath, watchDeliveryChanges } from "../runtime/delivery-control.mjs";
import { PrivateIpcServer } from "../runtime/private-ipc.mjs";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const fixture = () => { const path = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "dc-")); directories.push(path); return path; };
const entries = [{ id: "one", revision: "a".repeat(64) }];
it("subscribes before the snapshot, coalesces invalidations and releases subscriptions on abort", async () => {
  const directory = fixture();
  const server = new DeliveryControlServer(directory, async () => true);
  await server.start();
  const abort = new AbortController();
  const received: string[] = [];
  const watching = watchDeliveryChanges(directory, abort.signal, type => received.push(type));
  try {
    await vi.waitFor(() => expect(received).toEqual(["changed"]));
    for (let i = 0; i < 100; i++) server.changed();
    await vi.waitFor(() => expect(received).toEqual(["changed", "changed"]));
    expect(await requestDeliveryResolution(directory, entries, "ignore")).toBe("applied");
    abort.abort();
    await watching;
    server.changed();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(received).toEqual(["changed", "changed"]);
  } finally { abort.abort(); await watching; await server.close(); }
});

it("reports Gateway shutdown to subscribers without a hanging watch", async () => {
  const directory = fixture();
  const server = new DeliveryControlServer(directory, async () => true);
  await server.start();
  const received = vi.fn();
  const watching = watchDeliveryChanges(directory, new AbortController().signal, received).then(() => "closed", () => "disconnected");
  try {
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith("changed"));
    await server.close();
    expect(await watching).toBe("disconnected");
  } finally { await server.close(); }
});

it("bounds notification subscribers independently from mutation connections", async () => {
  const directory = fixture();
  const server = new DeliveryControlServer(directory, async () => true);
  await server.start();
  const abort = new AbortController();
  const callbacks = Array.from({ length: 8 }, () => vi.fn());
  const watchers = callbacks.map(receive => watchDeliveryChanges(directory, abort.signal, receive));
  try {
    await vi.waitFor(() => expect(callbacks.every(receive => receive.mock.calls.length === 1)).toBe(true));
    await expect(watchDeliveryChanges(directory, abort.signal, () => {})).rejects.toThrow();
    expect(await requestDeliveryResolution(directory, entries, "ignore")).toBe("applied");
  } finally { abort.abort(); await Promise.all(watchers); await server.close(); }
});
it("distinguishes missing endpoints from lost mutation responses and never retries", async () => {
  const directory = fixture();
  expect(await requestDeliveryResolution(directory, entries, "retry")).toBeNull();
  let calls = 0;
  const server = new PrivateIpcServer(deliveryControlSocketPath(directory), socket => {
    socket.on("error", () => {});
    socket.once("data", () => { calls++; socket.destroy(); });
  });
  await server.start("occupied");
  try {
    expect(await requestDeliveryResolution(directory, entries, "retry")).toBe("unconfirmed");
    expect(calls).toBe(1);
  } finally { await server.close(); }
});
it("bounds inputs and returns only controlled mutation results", async () => {
  const directory = fixture();
  let calls = 0;
  const server = new DeliveryControlServer(directory, async () => {
    calls++; if (calls === 1) return false;
    if (calls === 2) throw Object.assign(new Error("secret"), { code: "conflict" });
    if (calls === 3) throw new Error("secret");
    return true;
  });
  await server.start();
  try {
    await expect(requestDeliveryResolution(directory, [], "retry")).rejects.toThrow();
    await expect(requestDeliveryResolution(directory, [...entries, ...entries], "retry")).rejects.toThrow();
    expect(calls).toBe(0);
    for (const result of ["stale", "busy", "unconfirmed", "applied"]) expect(await requestDeliveryResolution(directory, entries, "ignore")).toBe(result);
  } finally { await server.close(); }
});

it.skipIf(process.platform === "win32")("uses bounded private endpoints for long directories and isolates directory identities", async () => {
  const directory = join(fixture(), "long-directory-".repeat(12));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = deliveryControlSocketPath(directory);
  expect(Buffer.byteLength(path)).toBeLessThan(104);
  expect(deliveryControlSocketPath(fixture())).not.toBe(path);
  const server = new DeliveryControlServer(directory, async () => true);
  await server.start();
  try {
    expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(await requestDeliveryResolution(directory, entries, "ignore")).toBe("applied");
    chmodSync(path, 0o644);
    await expect(requestDeliveryResolution(directory, entries, "ignore")).rejects.toThrow();
    chmodSync(path, 0o600);
  } finally { await server.close(); }
});
