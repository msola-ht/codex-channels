import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { InteractionRouter, type InteractionRequest } from "../src/approval/index.js";
import { surfaceAccountKey, type ConversationTarget } from "../src/conversation-core/index.js";
import { PersistentInteractionPort } from "../src/bootstrap/persistent-interaction-port.js";
import { PersistentSurfaceOutput } from "../src/bootstrap/persistent-surface-output.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "chat" };
const request: InteractionRequest = { type: "approval", requestId: "request", threadId: "thread", turnId: "turn", itemId: "item", kind: "command", title: "Approval", detail: "fixture", allowSession: false, expiresInMs: 5_000 };

it("waits for earlier durable output to be acknowledged before presenting an ephemeral approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "delivery-interaction-"));
  const events: string[] = [];
  let release!: () => void;
  const output = new PersistentSurfaceOutput({
    directory, workerUrl: new URL("../dist/delivery/worker.js", import.meta.url),
    owner: () => "owner", authorized: () => true,
    accounts: () => [surfaceAccountKey(target.surface, target.accountId)],
    deliver: async (_event, _signal, checkpoint) => {
      await checkpoint({ operation: "send", state: "started" });
      events.push("output-start");
      await new Promise<void>((resolve) => { release = resolve; });
      events.push("output-confirmed");
      await checkpoint({ operation: "send", state: "confirmed" });
    },
    fault: (code) => { events.push(code); },
  });
  const router = new InteractionRouter();
  router.register(target.surface, target.accountId, new PersistentInteractionPort({
    request: async () => { events.push("approval"); return { type: "approval", approved: true, scope: "once" }; },
  }, (conversation, signal) => output.waitForIdle(conversation, signal)));
  try {
    await output.start();
    output.accept({ type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "answer", text: "prior answer", phase: "final_answer" });
    const decision = router.request(target, request);
    await vi.waitFor(() => expect(events).toEqual(["output-start"]));
    release();
    await expect(decision).resolves.toMatchObject({ approved: true });
    expect(events).toEqual(["output-start", "output-confirmed", "approval"]);
  } finally {
    router.cancelAll();
    release?.();
    await output.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("cancels a blocked approval safely and prevents the old deadline from cancelling a replacement", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const native = { request: vi.fn(async () => ({ type: "approval" as const, approved: true as const, scope: "once" as const })), resolved: vi.fn() };
  const barrier = vi.fn<(_target: ConversationTarget, _signal: AbortSignal) => Promise<void>>()
    .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
    .mockResolvedValue(undefined);
  const port = new PersistentInteractionPort(native, barrier);
  try {
    const old = port.request(target, { ...request, expiresInMs: 100 });
    port.resolved(request.requestId);
    await expect(old).resolves.toEqual({ type: "approval", approved: false });
    expect(native.request).not.toHaveBeenCalled();
    await expect(port.request(target, request)).resolves.toMatchObject({ approved: true });
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(native.resolved).toHaveBeenCalledOnce();
  } finally { port.cancelAll(); vi.useRealTimers(); }
});

it("does not present an approval after an idle storage Worker exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "delivery-idle-failure-"));
  const fault = vi.fn();
  const output = new PersistentSurfaceOutput({ directory,
    workerUrl: new URL("../dist/delivery/worker.js", import.meta.url),
    owner: () => "owner", authorized: () => true, accounts: () => [], deliver: async () => {}, fault,
  });
  const native = { request: vi.fn(async () => ({ type: "approval" as const, approved: true as const, scope: "once" as const })) };
  const port = new PersistentInteractionPort(native, (conversation, signal) => output.waitForIdle(conversation, signal));
  try {
    await output.start();
    const journal = Reflect.get(output, "journal") as import("../src/delivery/index.js").DeliveryJournal;
    const worker = Reflect.get(journal, "worker") as import("node:worker_threads").Worker;
    await worker.terminate();
    expect(fault).toHaveBeenCalledExactlyOnceWith("storage");
    await expect(port.request(target, { ...request, expiresInMs: 25 })).resolves.toEqual({ type: "approval", approved: false });
    expect(native.request).not.toHaveBeenCalled();
    expect(Reflect.get(output, "idleWaiters").size).toBe(0);
  } finally {
    port.cancelAll(); await output.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
