import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentSurfaceOutput } from "../src/bootstrap/persistent-surface-output.js";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";
import { surfaceAccountKey } from "../src/conversation-core/index.js";
import { expect, it, vi } from "vitest";
import { GatewayComponentGraph } from "../src/bootstrap/gateway-component-graph.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { WorkspaceRegistry } from "../src/policy/index.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";

// Exercise the composition root's actual callbacks with isolated state, without
// constructing services, connecting an App Server or starting a Worker.
function fixture(background = true) {
  const bindings = new MemoryBindingStore();
  const target = { surface: "telegram" as const, accountId: "default", conversationId: "123" };
  bindings.selectWorkspace(target, "workspace");
  bindings.rememberActor(target, "123");
  const binding = { target, workspaceId: "workspace", threadId: "thread", sessionId: "session" };
  if (background) bindings.bindBackground(binding);
  else bindings.bind(binding);
  const allowed = new Set([123, 456]);
  let configured = true;
  let known: string | undefined = "provider";
  const workspaces = new WorkspaceRegistry([{ id: "workspace", name: "Workspace", cwd: "/fixture" }], "workspace");
  const graph = Object.assign(Object.create(GatewayComponentGraph.prototype) as {
    outputOwner(event: OutputEvent): string;
    outputAuthorized(event: OutputEvent, owner: string): boolean;
  }, {
    bindings, workspaces, router: { isBackgroundThread: (id: string) => bindings.isBackground(id) },
    codex: { knownProvider: () => known, isProviderConfigured: () => configured },
    config: { telegramEnabled: true, telegramAllowedUserIds: allowed }, surfaceModules: [],
  });
  const event: OutputEvent = { type: "turn.completed", target, threadId: "thread", turnId: "turn", status: "completed", background };
  const owner = graph.outputOwner(event);
  return { bindings, workspaces, target, allowed, graph, event, owner,
    forgetProvider: () => { known = undefined; }, disableProvider: () => { configured = false; } };
}

it("allows normal background cleanup while retaining the original Actor, Workspace and configured Provider", () => {
  const value = fixture();
  expect(value.graph.outputAuthorized(value.event, value.owner)).toBe(true);
  value.bindings.removeThread("thread");
  value.forgetProvider();
  expect(value.graph.outputAuthorized(value.event, value.owner)).toBe(true);
  value.disableProvider();
  expect(value.graph.outputAuthorized(value.event, value.owner)).toBe(false);
});

it.each(["transfer", "workspace", "actor", "revoked", "provider"])("blocks recovery after %s changes", (change) => {
  const value = fixture();
  if (change === "transfer") {
    const binding = value.bindings.removeThread("thread")!;
    value.bindings.bind({ ...binding, target: { ...value.target, conversationId: "456" } });
  }
  if (change === "workspace") value.bindings.selectWorkspace(value.target, "other");
  if (change === "actor") { value.bindings.forgetActor(value.target, "123"); value.bindings.rememberActor(value.target, "456"); }
  if (change === "revoked") value.allowed.clear();
  if (change === "provider") value.disableProvider();
  expect(value.graph.outputAuthorized(value.event, value.owner)).toBe(false);
});

it("does not apply background cleanup relaxation to a removed foreground binding", () => {
  const value = fixture(false);
  value.bindings.removeThread("thread");
  expect(value.graph.outputAuthorized(value.event, value.owner)).toBe(false);
});


it.each([false, true])("blocks a revoked Workspace even with a stale selection (background=%s)", (background) => {
  const value = fixture(background);
  if (background) value.bindings.removeThread("thread");
  value.workspaces.replace([{ id: "replacement", name: "Replacement", cwd: "/replacement" }], "replacement");
  expect(value.bindings.getWorkspace(value.target)).toBe("workspace");
  expect(value.graph.outputAuthorized(value.event, value.owner)).toBe(false);
});


it("retains a pending result as blocked after restart when its background Workspace was removed", async () => {
  const value = fixture();
  const directory = mkdtempSync(join(tmpdir(), "codexc-owner-review-"));
  const deliver = vi.fn(async () => {});
  const fault = vi.fn();
  const create = (online: boolean) => new PersistentSurfaceOutput({
    directory, workerUrl: new URL("../dist/delivery/worker.js", import.meta.url),
    owner: (event) => value.graph.outputOwner(event),
    authorized: (event, owner) => value.graph.outputAuthorized(event, owner),
    accounts: () => online ? [surfaceAccountKey(value.target.surface, value.target.accountId)] : [],
    deliver, fault,
  });
  let output = create(false);
  try {
    await output.start();
    output.accept(value.event);
    await output.close();
    value.bindings.removeThread("thread");
    value.workspaces.replace([{ id: "replacement", name: "Replacement", cwd: "/replacement" }], "replacement");
    output = create(true);
    await output.start();
    await vi.waitFor(() => expect(fault).toHaveBeenCalledWith("authorization-changed", expect.any(String)));
    await output.close();
    expect(deliver).not.toHaveBeenCalled();
    const journal = new SqliteDeliveryJournal(directory);
    try { expect(journal.execute({ type: "summary" })).toMatchObject({ records: 1, blocked: 1 }); }
    finally { journal.close(); }
  } finally { await output.close(); rmSync(directory, { recursive: true, force: true }); }
});
