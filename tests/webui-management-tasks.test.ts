import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeTaskInput, WebuiManagementTaskRunner } from "../scripts/webui-management-tasks.mjs";

describe("WebUI management tasks", () => {
  it("accepts only the documented service and maintenance actions", () => {
    expect(normalizeTaskInput({ operation: "service", action: "restart", target: "gateway" })).toEqual({ operation: "service", action: "restart", target: "gateway" });
    expect(normalizeTaskInput({ operation: "service", action: "reload" })).toEqual({ operation: "service", action: "reload", target: undefined });
    expect(normalizeTaskInput({ operation: "metrics", action: "cleanup" })).toEqual({ operation: "metrics", action: "cleanup" });
    expect(normalizeTaskInput({ operation: "metrics", action: "prune", target: "deepseek" })).toEqual({ operation: "metrics", action: "prune", target: "deepseek" });
    expect(normalizeTaskInput({ operation: "update" })).toEqual({ operation: "update", action: "source", target: undefined });
    expect(() => normalizeTaskInput({ operation: "service", action: "exec", target: "gateway" })).toThrow();
    expect(() => normalizeTaskInput({ operation: "service", action: "reload", target: "gateway" })).toThrow("服务重载不接受服务目标");
    expect(() => normalizeTaskInput({ operation: "metrics", action: "shell" })).toThrow();
    expect(() => normalizeTaskInput({ operation: "metrics", action: "prune" })).toThrow();
    expect(() => normalizeTaskInput({ operation: "metrics", action: "cleanup", target: "deepseek" })).toThrow();
  });

  it("returns an explicit confirmation preview", () => {
    const runner = new WebuiManagementTaskRunner();
    expect(runner.preview({ operation: "service", action: "stop", target: "webui" })).toMatchObject({
      operation: "service",
      requiresConfirmation: true,
    });
    expect(runner.preview({ operation: "service", action: "reload" })).toMatchObject({
      effects: ["执行 codexc service reload"],
      target: null,
    });
    expect(runner.preview({ operation: "metrics", action: "prune", target: "deepseek" })).toMatchObject({
      target: "deepseek",
      effects: ["执行 codexc metrics prune deepseek"],
      preconditions: [],
      activation: "按操作前状态恢复 Gateway 和指标中心",
    });
    expect(runner.preview({ operation: "metrics", action: "cleanup" })).toMatchObject({
      preconditions: ["Gateway 必须已停止，且指标 Socket 不可用"],
      recovery: expect.stringContaining("同步水位备份"),
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
      const runner = new WebuiManagementTaskRunner();
      const task = runner.start(
        { operation: "update" },
        { owner: "owner-output", environment: { ...process.env, PATH: directory } },
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = runner.get(task.id, "owner-output");
        if (current?.state === "failed") {
          expect(current.error).toBe("任务失败（退出码 7）");
          expect(current.error).not.toContain("super-secret");
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("管理任务未在预期时间内结束");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
