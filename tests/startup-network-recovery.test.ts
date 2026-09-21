import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import policy from "../startup-network-policy.json" with { type: "json" };
import { StartupNetworkRecovery } from "../src/bootstrap/startup-network-recovery.js";
import type { McpServerStatus } from "../src/conversation-core/index.js";
import type { OpenAiConnectivityStatus } from "../src/bootstrap/openai-connectivity.js";
import type { McpServerSummary } from "../src/application/index.js";

const running: StartupNetworkRecovery[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((recovery) => recovery.stop())); });

function fixture(overrides: Partial<typeof policy> = {}) {
  const probe = vi.fn<(signal: AbortSignal) => Promise<OpenAiConnectivityStatus>>().mockResolvedValue("reachable");
  const snapshot = vi.fn<(threadId: string, signal: AbortSignal) => Promise<McpServerSummary[]>>().mockResolvedValue([]);
  const reloadMcp = vi.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
  const recovered = vi.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
  const status = vi.fn();
  const notify = vi.fn();
  const recovery = new StartupNetworkRecovery({
    logger: pino({ level: "silent" }), probe, snapshot, reloadMcp, recovered, status, notify,
    policy: { ...policy, recoveryRetryDelaysMs: [1, 2, 3], recoveryDeadlineMs: 1_000, mcpReadyTimeoutMs: 20, stopTimeoutMs: 100, ...overrides },
  });
  running.push(recovery);
  return { recovery, probe, snapshot, reloadMcp, recovered, status, notify };
}

function apps(status: McpServerStatus["status"], threadId = "thread-1"): McpServerStatus {
  return { threadId, name: "codex_apps", status, error: null, failureReason: null };
}

describe("bounded startup network recovery", () => {
  it.each(["unreachable", "reachable"] as const)("rechecks a timed-out snapshot after verifying the network from %s", async (initial) => {
    const f = fixture({ probeDeadlineMs: 5 });
    f.snapshot.mockImplementationOnce((_threadId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })).mockResolvedValue([mcpSnapshot("failed")]);
    f.reloadMcp.mockImplementation(async () => { f.recovery.observeMcp(apps("ready")); });
    f.recovery.start(initial, ["thread-1"]);
    await vi.waitFor(() => expect(f.reloadMcp).toHaveBeenCalledOnce());
    expect(f.snapshot).toHaveBeenCalledTimes(2);
    expect(f.probe).toHaveBeenCalledOnce();
  });

  it.each(["ready", "closed"] as const)("drops a failed snapshot retry after a newer %s event", async (event) => {
    const f = fixture();
    f.snapshot.mockRejectedValue(new Error("snapshot unavailable"));
    f.probe.mockImplementation(async () => {
      if (event === "ready") f.recovery.observeMcp(apps("ready"));
      else f.recovery.forgetThread("thread-1");
      return "reachable";
    });
    f.recovery.start("unreachable", ["thread-1"]);
    await vi.waitFor(() => expect(f.recovered).toHaveBeenCalledOnce());
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });

  it("reports an unresolved snapshot after one bounded retry", async () => {
    const f = fixture();
    f.snapshot.mockRejectedValue(new Error("snapshot unavailable"));
    f.recovery.start("unreachable", ["thread-1"]);
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("MCP 状态仍无法读取")));
    expect(f.snapshot).toHaveBeenCalledTimes(2);
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });

  it("keeps newer readiness when the retried snapshot returns stale failure", async () => {
    const f = fixture();
    f.snapshot.mockRejectedValueOnce(new Error("snapshot unavailable")).mockImplementationOnce(async () => {
      f.recovery.observeMcp(apps("ready"));
      return [mcpSnapshot("failed")];
    });
    f.recovery.start("unreachable", ["thread-1"]);
    await vi.waitFor(() => expect(f.recovered).toHaveBeenCalledOnce());
    expect(f.snapshot).toHaveBeenCalledTimes(2);
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });

  it.each(["unreachable", "temporarily-unavailable"] as const)("continues after a transient HTTP failure from %s", async (initial) => {
    const f = fixture();
    f.probe.mockResolvedValueOnce("temporarily-unavailable");
    f.recovery.start(initial);
    await vi.waitFor(() => expect(f.recovered).toHaveBeenCalledOnce());
    expect(f.probe).toHaveBeenCalledTimes(2);
    expect(f.status).toHaveBeenLastCalledWith("reachable");
  });

  it("recovers an existing failed MCP without a new failure notification", async () => {
    const f = fixture();
    f.snapshot.mockResolvedValue([mcpSnapshot("failed")]);
    f.reloadMcp.mockImplementation(async () => { f.recovery.observeMcp(apps("ready")); });
    f.recovery.start("reachable", ["thread-1"]);
    await vi.waitFor(() => expect(f.reloadMcp).toHaveBeenCalledOnce());
    expect(f.snapshot).toHaveBeenCalledOnce();
  });

  it.each(["connected", "authenticationRequired", "disabled"] as const)("does not reload a restored %s MCP", async (runtimeStatus) => {
    const f = fixture();
    f.snapshot.mockResolvedValue([mcpSnapshot(runtimeStatus)]);
    f.recovery.start("reachable", ["thread-1"]);
    await vi.waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
    await f.recovery.stop();
    expect(f.reloadMcp).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
  });

  it.each(["ready", "closed"] as const)("does not overwrite a newer %s event with a failed snapshot", async (event) => {
    const f = fixture();
    f.snapshot.mockImplementation(async () => {
      if (event === "ready") f.recovery.observeMcp(apps("ready"));
      else f.recovery.forgetThread("thread-1");
      return [mcpSnapshot("failed")];
    });
    f.recovery.start("reachable", ["thread-1"]);
    await vi.waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
    await f.recovery.stop();
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });

  it("preserves a new failure arriving while a connected snapshot is read", async () => {
    const f = fixture();
    f.snapshot.mockImplementation(async () => {
      f.recovery.observeMcp(apps("failed"));
      return [mcpSnapshot("connected")];
    });
    f.reloadMcp.mockImplementation(async () => { f.recovery.observeMcp(apps("ready")); });
    f.recovery.start("reachable", ["thread-1"]);
    await vi.waitFor(() => expect(f.reloadMcp).toHaveBeenCalledOnce());
  });

  it("cancels an outstanding snapshot on shutdown", async () => {
    const f = fixture();
    f.snapshot.mockImplementation((_threadId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    f.recovery.start("reachable", ["thread-1"]);
    await vi.waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
    await f.recovery.stop();
    expect(f.snapshot.mock.calls[0]?.[1].aborted).toBe(true);
    expect(f.reloadMcp).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });
  it("recovers after the initial startup window and refreshes MCP exactly once", async () => {
    const f = fixture();
    f.probe.mockResolvedValueOnce("unreachable").mockResolvedValueOnce("unreachable");
    f.recovery.observeMcp(apps("failed"));
    f.reloadMcp.mockImplementation(async () => { f.recovery.observeMcp(apps("ready")); });
    f.recovery.start("unreachable");
    f.recovery.start("unreachable");
    expect(f.status).toHaveBeenCalledWith("recovering");
    await vi.waitFor(() => expect(f.recovered).toHaveBeenCalledOnce());
    expect(f.probe).toHaveBeenCalledTimes(3);
    expect(f.reloadMcp).toHaveBeenCalledOnce();
    expect(f.status).toHaveBeenLastCalledWith("reachable");
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it("does not treat a successful reload RPC as MCP readiness", async () => {
    const f = fixture();
    f.recovery.observeMcp(apps("failed"));
    f.recovery.start("unreachable");
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("尚未确认就绪")));
    expect(f.reloadMcp).toHaveBeenCalledOnce();
  });

  it("does not reload when the native client has already recovered", async () => {
    const f = fixture();
    f.recovery.observeMcp(apps("failed"));
    f.recovery.observeMcp(apps("ready"));
    f.recovery.start("unreachable");
    await vi.waitFor(() => expect(f.recovered).toHaveBeenCalledOnce());
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });

  it("excludes authentication failures, other servers and closed threads", async () => {
    const f = fixture();
    f.recovery.observeMcp({ ...apps("failed"), failureReason: "reauthenticationRequired" });
    f.recovery.observeMcp({ ...apps("failed"), name: "custom-mcp" });
    f.recovery.observeMcp(apps("failed", "closed"));
    f.recovery.forgetThread("closed");
    f.recovery.start("unreachable");
    await vi.waitFor(() => expect(f.recovered).toHaveBeenCalledOnce());
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });

  it("can recover a startup MCP failure when the initial network probe has already succeeded", async () => {
    const f = fixture();
    f.recovery.observeMcp(apps("failed"));
    f.reloadMcp.mockImplementation(async () => { f.recovery.observeMcp(apps("ready")); });
    f.recovery.start("reachable");
    await vi.waitFor(() => expect(f.reloadMcp).toHaveBeenCalledOnce());
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("includes a late startup failure after the channel has started", async () => {
    const f = fixture();
    f.recovery.start("reachable");
    f.reloadMcp.mockImplementation(async () => { f.recovery.observeMcp(apps("ready")); });
    f.recovery.observeMcp(apps("failed"));
    await vi.waitFor(() => expect(f.reloadMcp).toHaveBeenCalledOnce());
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("still observes MCP startup failures after the network has recovered first", async () => {
    const f = fixture();
    f.recovery.start("unreachable");
    await vi.waitFor(() => expect(f.recovered).toHaveBeenCalledOnce());
    f.reloadMcp.mockImplementation(async () => { f.recovery.observeMcp(apps("ready")); });
    f.recovery.observeMcp(apps("failed"));
    await vi.waitFor(() => expect(f.reloadMcp).toHaveBeenCalledOnce());
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it.each(["reachable", "not-applicable", "invalid-base-url", "route-warning"] as const)("does not poll an unaffected or configuration-error startup: %s", async (initial) => {
    const f = fixture();
    f.recovery.start(initial);
    await f.recovery.stop();
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("ends finite retries without refreshing MCP on an offline machine", async () => {
    const f = fixture();
    f.probe.mockResolvedValue("unreachable");
    f.recovery.start("unreachable");
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("自动复检已结束")));
    expect(f.status).toHaveBeenLastCalledWith("unreachable");
    expect(f.probe).toHaveBeenCalledTimes(3);
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });

  it("cancels an in-flight probe without a late recovery or notification", async () => {
    const f = fixture();
    f.probe.mockImplementation((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    f.recovery.start("unreachable");
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalledOnce());
    await f.recovery.stop();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });

  it("does not retry a reload whose delivery is uncertain", async () => {
    const f = fixture();
    f.recovery.observeMcp(apps("failed"));
    f.reloadMcp.mockRejectedValue(new Error("disconnected"));
    f.recovery.start("unreachable");
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("启动恢复未完成")));
    expect(f.reloadMcp).toHaveBeenCalledOnce();
  });

  it("enforces the overall deadline on an in-flight probe", async () => {
    const f = fixture({ recoveryDeadlineMs: 30 });
    f.probe.mockImplementation((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    f.recovery.start("unreachable");
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("自动复检已结束")));
    expect(f.probe.mock.calls[0]?.[0].aborted).toBe(true);
    expect(f.reloadMcp).not.toHaveBeenCalled();
  });
});

function mcpSnapshot(runtimeStatus: McpServerSummary["runtimeStatus"]): McpServerSummary {
  return { name: "codex_apps", runtimeStatus, authStatus: "oAuth", pluginId: null, toolCount: 0, toolDiscoveryFailed: false };
}
