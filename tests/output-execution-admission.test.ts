import { describe, expect, it, vi } from "vitest";
import type { ThreadQueuePort, TurnExecutionPort } from "../src/application/index.js";
import { withOutputExecutionAdmission } from "../src/bootstrap/output-execution-admission.js";

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
