import { describe, expect, it, vi } from "vitest";
import type { ThreadQueuePort, TurnExecutionPort } from "../src/application/index.js";
import { withOutputExecutionAdmission } from "../src/bootstrap/output-execution-admission.js";
import { GatewayApplication } from "../src/bootstrap/app.js";

type Port = TurnExecutionPort & ThreadQueuePort;
const actions: Array<{ name: keyof Port; invoke(port: Port): Promise<unknown> }> = [
  { name: "startTurn", invoke: (port) => port.startTurn("thread", [], "message", "/workspace") },
  { name: "steerTurn", invoke: (port) => port.steerTurn("thread", "turn", [], "message") },
  { name: "compactThread", invoke: (port) => port.compactThread("thread") },
  { name: "startReview", invoke: (port) => port.startReview("thread", { type: "uncommittedChanges" }) },
  { name: "setGoal", invoke: (port) => port.setGoal("thread", "goal") },
  { name: "addQueueItem", invoke: (port) => port.addQueueItem("thread", "text", "message") },
  { name: "updateQueueItem", invoke: (port) => port.updateQueueItem("thread", "item", "text") },
  { name: "startQueueItem", invoke: (port) => port.startQueueItem("thread") },
];

describe("output capacity execution admission", () => {
  it.each(actions)("waits for asynchronous admission and propagates rejection before $name", async ({ name, invoke }) => {
    let finish!: (error?: Error) => void;
    const call = vi.fn(async () => undefined);
    const port = withOutputExecutionAdmission({ [name]: call } as unknown as Port,
      () => new Promise<void>((resolve, reject) => { finish = error => error ? reject(error) : resolve(); }));
    const pending = invoke(port);
    expect(call).not.toHaveBeenCalled();
    const rejected = expect(pending).rejects.toThrow("reviewer unavailable");
    finish(new Error("reviewer unavailable"));
    await rejected;
    expect(call).not.toHaveBeenCalled();
  });
  it.each(actions)("fences $name before any App Server call and permits it after recovery", async ({ name, invoke }) => {
    let available = false;
    const call = vi.fn(async () => undefined);
    const port = withOutputExecutionAdmission({ [name]: call } as unknown as Port, (threadId) => {
      expect(threadId).toBe("thread");
      if (!available) throw new Error("delivery full");
    });
    await expect(invoke(port)).rejects.toThrow("delivery full");
    expect(call).not.toHaveBeenCalled();
    available = true;
    await invoke(port);
    expect(call).toHaveBeenCalledOnce();
  });

  it("keeps stop, inspection and Queue deletion available during overload", async () => {
    const call = vi.fn(async () => undefined);
    const port = withOutputExecutionAdmission({ interruptTurn: call, listQueue: call, deleteQueueItem: call } as unknown as Port,
      () => { throw new Error("must not gate recovery operations"); });
    await port.interruptTurn("thread", "turn");
    await port.listQueue("thread");
    await port.deleteQueueItem("thread", "item");
    expect(call).toHaveBeenCalledTimes(3);
  });
});

describe("Thread reviewer execution admission", () => {
  function fixture(reviewer: string | null = "auto_review", provider = "deepseek") {
    const binding = { threadId: "thread", workspaceId: "main", target: { surface: "telegram", accountId: "default", conversationId: "100" } };
    const settings = { modelProvider: provider, approvalsReviewer: reviewer };
    const readThread = vi.fn(async () => ({ id: "thread", cwd: "/workspace", modelProvider: provider, status: { type: "idle" }, activeTurnId: null as string | null }));
    const updateThreadApprovalsReviewer = vi.fn(async (_id: string, actual: string) => { settings.approvalsReviewer = actual; });
    const drain = vi.fn(async () => undefined);
    const activeTurn = vi.fn(() => undefined as string | undefined);
    const harness = Object.assign(Object.create(GatewayApplication.prototype), {
      router: { modelSettingsForThread: () => settings, isAutoReviewSupported: (id: string) => id === "openai" || id === "compatible" },
      bindings: { getByThread: () => binding }, workspaces: { get: () => ({ cwd: "/workspace" }) },
      codex: { readThread, updateThreadApprovalsReviewer }, inbound: { drain },
      interactions: { hasPendingForThread: () => false }, stopping: false,
      core: { activeTurnForThread: activeTurn },
    }) as { admitThreadApprovalsReviewer(id: string): Promise<void>; stopping: boolean; bindingRestore?: { isRestoring(id: string): boolean } };
    return { harness, settings, readThread, updateThreadApprovalsReviewer, drain, activeTurn };
  }

  it.each(["user", "auto_review", "guardian_subagent", null])("preserves supported Provider execution with actual reviewer %s without resuming or updating", async reviewer => {
    for (const provider of ["openai", "compatible"]) {
      const { harness, readThread, updateThreadApprovalsReviewer } = fixture(reviewer, provider);
      await harness.admitThreadApprovalsReviewer("thread");
      expect(readThread).not.toHaveBeenCalled();
      expect(updateThreadApprovalsReviewer).not.toHaveBeenCalled();
    }
  });

  it("waits for inbound state and confirms user before allowing an external auto_review override", async () => {
    const { harness, settings, drain, readThread, updateThreadApprovalsReviewer } = fixture("user");
    drain.mockImplementationOnce(async () => { settings.approvalsReviewer = "auto_review"; });
    let finish!: () => void;
    updateThreadApprovalsReviewer.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      settings.approvalsReviewer = "user";
    });
    const pending = harness.admitThreadApprovalsReviewer("thread");
    await vi.waitFor(() => expect(updateThreadApprovalsReviewer).toHaveBeenCalledWith("thread", "user"));
    expect(settings.approvalsReviewer).toBe("auto_review");
    expect(readThread).toHaveBeenCalledOnce();
    finish();
    await pending;
    expect(settings.approvalsReviewer).toBe("user");
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "active-race", "unknown", "guardian", "failed", "unconfirmed", "disconnected", "shutdown"])("rejects new execution safely (%s)", async scenario => {
    const { harness, settings, readThread, updateThreadApprovalsReviewer, activeTurn } = fixture(scenario === "unknown" ? null : scenario === "guardian" ? "guardian_subagent" : "auto_review");
    if (scenario === "active") readThread.mockResolvedValueOnce({ id: "thread", cwd: "/workspace", modelProvider: "deepseek", status: { type: "active" }, activeTurnId: "turn" });
    if (scenario === "failed") updateThreadApprovalsReviewer.mockRejectedValueOnce(new Error("sensitive response"));
    if (scenario === "active-race") updateThreadApprovalsReviewer.mockImplementationOnce(async () => {
      settings.approvalsReviewer = "user";
      activeTurn.mockReturnValue("turn");
    });
    if (scenario === "unconfirmed") updateThreadApprovalsReviewer.mockImplementationOnce(async () => undefined);
    if (scenario === "disconnected") harness.bindingRestore = { isRestoring: () => true };
    if (scenario === "shutdown") harness.stopping = true;
    await expect(harness.admitThreadApprovalsReviewer("thread")).rejects.toMatchObject({ code: "autoreview.execution-blocked" });
    if (["active", "unknown", "guardian", "disconnected", "shutdown"].includes(scenario)) expect(updateThreadApprovalsReviewer).not.toHaveBeenCalled();
  });
});
