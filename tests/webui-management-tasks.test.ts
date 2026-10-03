import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { normalizeTaskInput, WebuiManagementTaskRunner } from "../scripts/webui-management-tasks.mjs";

describe("WebUI management tasks", () => {
  it("notifies only the owner for queued, running and failed tasks without audit metadata", async () => {
    const runner = new WebuiManagementTaskRunner();
    const a = new AbortController(), b = new AbortController();
    const states: string[] = [], other: string[] = [];
    const first = runner.watch("a", a.signal, type => { expect(type).toBe("changed"); states.push(runner.list("a").at(-1)?.state ?? "empty"); });
    const second = runner.watch("b", b.signal, type => other.push(type));
    try {
      runner.start({ operation: "update" }, { owner: "a", environment: { PATH: "" } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(states).toEqual(["empty", "queued", "running", "failed"]);
      expect(other).toEqual(["changed"]);
      a.abort();
      runner.start({ operation: "update" }, { owner: "a", environment: { PATH: "" } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(states).toHaveLength(4);
    } finally { a.abort(); b.abort(); await Promise.all([first, second]); }
  });

  it("sends heartbeats and releases subscription timers on abort or subscriber failure", async () => {
    vi.useFakeTimers();
    const runner = new WebuiManagementTaskRunner(), controller = new AbortController();
    const events: string[] = [];
    try {
      const watch = runner.watch("a", controller.signal, type => events.push(type));
      vi.advanceTimersByTime(30_000);
      expect(events).toEqual(["changed", "heartbeat", "heartbeat"]);
      controller.abort(); await watch;
      vi.advanceTimersByTime(30_000);
      expect(events).toHaveLength(3);
      await expect(runner.watch("b", new AbortController().signal, () => { throw new Error("disconnected"); })).rejects.toThrow("disconnected");
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); vi.useRealTimers(); }
  });

  it("notifies queued cancellation even when terminal audit fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runner = new WebuiManagementTaskRunner({ onEvent: () => { throw new Error("audit unavailable"); } });
    const controller = new AbortController(), events: string[] = [];
    const watch = runner.watch("a", controller.signal, () => events.push(runner.list("a").at(-1)?.state ?? "empty"));
    try {
      const task = runner.start({ operation: "update" }, { owner: "a", environment: { PATH: "" }, auditMetadata: { sessionId: "a" } });
      runner.cancel(task.id, "a");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(events).toEqual(["empty", "queued", "cancelled"]);
      expect(log).toHaveBeenCalledOnce();
    } finally { controller.abort(); await watch; log.mockRestore(); }
  });
  it("accepts only the documented service and maintenance actions", () => {
    expect(normalizeTaskInput({ operation: "service", action: "restart", target: "gateway" })).toEqual({ operation: "service", action: "restart", target: "gateway" });
    expect(normalizeTaskInput({ operation: "service", action: "stop", target: "model-relay" })).toEqual({ operation: "service", action: "stop", target: "model-relay" });
    expect(normalizeTaskInput({ operation: "service", action: "reload" })).toEqual({ operation: "service", action: "reload", target: undefined });
    expect(normalizeTaskInput({ operation: "metrics", action: "cleanup" })).toEqual({ operation: "metrics", action: "cleanup" });
    expect(normalizeTaskInput({ operation: "metrics", action: "prune", target: "deepseek" })).toEqual({ operation: "metrics", action: "prune", target: "deepseek" });
    expect(normalizeTaskInput({ operation: "traffic", action: "cleanup" })).toEqual({ operation: "traffic", action: "cleanup", target: undefined });
    expect(normalizeTaskInput({ operation: "update" })).toEqual({ operation: "update", action: "source", target: undefined });
    expect(() => normalizeTaskInput({ operation: "service", action: "exec", target: "gateway" })).toThrow();
    expect(() => normalizeTaskInput({ operation: "service", action: "reload", target: "gateway" })).toThrow("服务重载不接受服务目标");
    expect(() => normalizeTaskInput({ operation: "metrics", action: "shell" })).toThrow();
    expect(() => normalizeTaskInput({ operation: "metrics", action: "prune" })).toThrow();
    expect(() => normalizeTaskInput({ operation: "metrics", action: "cleanup", target: "deepseek" })).toThrow();
    expect(() => normalizeTaskInput({ operation: "traffic", action: "cleanup", target: "openai" })).toThrow();
  });

  it("returns an explicit confirmation preview", () => {
    const runner = new WebuiManagementTaskRunner();
    expect(runner.preview({ operation: "service", action: "stop", target: "webui" })).toMatchObject({
      operation: "service",
      requiresConfirmation: true,
    });
    expect(runner.preview({ operation: "service", action: "stop", target: "model-relay" })).toMatchObject({ effects: ["执行 codexc service stop relay"] });
    expect(runner.preview({ operation: "service", action: "reload" })).toMatchObject({
      effects: ["执行 codexc service reload"],
      target: null,
    });
    expect(runner.preview({ operation: "metrics", action: "prune", target: "deepseek" })).toMatchObject({
      target: "deepseek",
      effects: ["执行 codexc metrics prune deepseek"],
      preconditions: [],
      activation: "按操作前状态恢复 Gateway",
    });
    expect(runner.preview({ operation: "metrics", action: "cleanup" })).toMatchObject({
      preconditions: ["Gateway 必须已停止，且指标 Socket 不可用"],
      recovery: expect.stringContaining("指标数据库备份"),
    });
    expect(runner.preview({ operation: "traffic", action: "cleanup" })).toMatchObject({
      effects: ["执行 codexc traffic cleanup --confirm"],
      preconditions: ["全部 App Server 与 Relay 必须已停止"],
      recovery: expect.stringContaining("无法恢复"),
    });
  });

  it("turns executable resolution failures into a failed task and emits a terminal event", async () => {
    const events: Array<{ phase: string; resultCode: string }> = [];
    const runner = new WebuiManagementTaskRunner({
      onEvent: ({ phase, resultCode }) => events.push({ phase, resultCode }),
    });
    const task = runner.start(
      { operation: "update" },
      { owner: "owner-a", environment: { PATH: "" }, auditMetadata: { sessionId: "session-a" } },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.get(task.id, "owner-a")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("找不到可执行文件"),
    });
    expect(events).toEqual([{ phase: "failed", resultCode: "failed" }]);
  });

  it("does not expose maintenance command output in a failed task", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-webui-task-output-"));
    const executable = process.platform === "win32" ? join(directory, "codexc.cmd") : join(directory, "codexc");
    try {
      if (process.platform === "win32") {
        writeFileSync(executable, "@echo off\r\necho api-key=super-secret\r\nexit /b 7\r\n", { mode: 0o700 });
      } else {
        writeFileSync(executable, "#!/bin/sh\nprintf 'api-key=super-secret\\n' >&2\nexit 7\n", { mode: 0o700 });
        chmodSync(executable, 0o700);
      }
      let resolveTaskFinished: () => void = () => undefined;
      const taskFinished = new Promise<void>((resolve) => {
        resolveTaskFinished = resolve;
      });
      const runner = new WebuiManagementTaskRunner({
        onEvent: () => resolveTaskFinished(),
      });
      const task = runner.start(
        { operation: "update" },
        {
          owner: "owner-output",
          environment: { ...process.env, PATH: directory },
          auditMetadata: { sessionId: "session-output" },
        },
      );
      await taskFinished;
      const current = runner.get(task.id, "owner-output");
      expect(current).toMatchObject({
        state: "failed",
        error: "任务失败（退出码 7）",
      });
      expect(current?.error).not.toContain("super-secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
