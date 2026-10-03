import { appendFileSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { matchesTrafficChange, watchTrafficChanges } from "../scripts/webui-traffic-events.mjs";

const cleanups: Array<() => Promise<void>> = [];
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, watch: vi.fn(fs.watch) };
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it("watches only matching batch directories, independent of file count, and ignores unrelated writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "webui-traffic-scope-"));
  const directory = join(root, "traffic");
  const own = join(directory, "openai-batch"), other = join(directory, "other-batch");
  mkdirSync(own, { recursive: true });
  mkdirSync(other);
  for (let index = 1; index <= 100; index++) writeFileSync(join(own, `payload-${index}.bin`), "body");
  vi.mocked(watch).mockClear();
  const controller = new AbortController(), send = vi.fn();
  const pending = watchTrafficChanges(directory, { label: "openai", session: "batch", detail: true }, controller.signal, send);
  cleanups.push(async () => { controller.abort(); await pending; rmSync(root, { recursive: true, force: true }); });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("changed"));
  expect(vi.mocked(watch).mock.calls.map(call => call[0])).toEqual([root, directory, own]);
  send.mockClear();
  writeFileSync(join(other, "interactions.jsonl"), "other\n");
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(send).not.toHaveBeenCalled();
  appendFileSync(join(own, "payload-1.bin"), "more");
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("changed"));
  expect(vi.mocked(watch)).toHaveBeenCalledTimes(3);
});

it("filters batch notifications and keeps trace/body writes out of summary subscriptions", () => {
  const scope = { label: "relay.responses", session: "batch", detail: false };
  expect(matchesTrafficChange("relay.responses-batch/interactions.jsonl", scope)).toBe(true);
  expect(matchesTrafficChange("relay.responses-batch\\manifest.json", scope)).toBe(true);
  expect(matchesTrafficChange("relay.responses-other/interactions.jsonl", scope)).toBe(false);
  expect(matchesTrafficChange("other-batch/interactions.jsonl", scope)).toBe(false);
  expect(matchesTrafficChange("relay.responses-batch/trace-1.jsonl", scope)).toBe(false);
  expect(matchesTrafficChange("relay.responses-batch/payload-1.bin", { ...scope, detail: true })).toBe(true);
  expect(matchesTrafficChange("relay.responses-batch/trace-1.jsonl", { ...scope, detail: true })).toBe(true);
  expect(matchesTrafficChange("relay.responses-batch/private/file", { ...scope, detail: true })).toBe(false);
  expect(matchesTrafficChange(null, scope)).toBe(true);
});

it("observes the first dump, coalesces writes, follows directory replacement and stops on abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "webui-traffic-events-"));
  const directory = join(root, "traffic");
  const controller = new AbortController();
  const send = vi.fn();
  const pending = watchTrafficChanges(directory, {}, controller.signal, send);
  cleanups.push(async () => { controller.abort(); await pending; rmSync(root, { recursive: true, force: true }); });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("changed"));
  send.mockClear();
  const batch = join(directory, "openai-batch");
  mkdirSync(batch, { recursive: true });
  writeFileSync(join(batch, "manifest.json"), "{}");
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("changed"));
  await new Promise(resolve => setTimeout(resolve, 200));
  send.mockClear();
  for (let index = 0; index < 20; index++) appendFileSync(join(batch, "interactions.jsonl"), `${index}\n`);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(send).toHaveBeenCalledTimes(1);
  send.mockClear();
  rmSync(directory, { recursive: true });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("changed"));
  send.mockClear();
  mkdirSync(batch, { recursive: true });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("changed"));
  await new Promise(resolve => setTimeout(resolve, 200));
  send.mockClear();
  writeFileSync(join(batch, "interactions.jsonl"), "after replacement\n");
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("changed"));
  controller.abort();
  await pending;
  send.mockClear();
  appendFileSync(join(batch, "interactions.jsonl"), "after abort\n");
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(send).not.toHaveBeenCalled();
});
