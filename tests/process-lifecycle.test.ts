import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  assertSynchronousChildSuccess,
  childProcessIsRunning,
  ForwardedChildSignalError,
  installProcessSignalHandlers,
  ReportedChildExitError,
  signalChildProcesses,
  terminateChildProcess,
} from "../runtime/process-lifecycle.mjs";

describe("process lifecycle primitives", () => {
  it("signals only running children", () => {
    const running = { exitCode: null, signalCode: null, kill: vi.fn() };
    const exited = { exitCode: 0, signalCode: null, kill: vi.fn() };
    signalChildProcesses([running, exited], "SIGTERM");
    expect(childProcessIsRunning(running)).toBe(true);
    expect(running.kill).toHaveBeenCalledWith("SIGTERM");
    expect(exited.kill).not.toHaveBeenCalled();
  });

  it("waits for the child to exit after escalating to SIGKILL", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true),
    });
    let completed = false;
    const termination = terminateChildProcess(
      child as unknown as Parameters<typeof terminateChildProcess>[0],
      {
        gracePeriodMs: 1,
        forcePeriodMs: 100,
      },
    ).then(() => {
      completed = true;
    });

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));
    expect(completed).toBe(false);
    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");
    await termination;
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("installs and idempotently removes signal handlers", () => {
    const source = new EventEmitter();
    const terminate = vi.fn();
    const cleanup = installProcessSignalHandlers({ SIGTERM: terminate }, source);
    source.emit("SIGTERM");
    cleanup();
    cleanup();
    source.emit("SIGTERM");
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("preserves child-reported failures without creating a second message", () => {
    expect(() => assertSynchronousChildSuccess(
      { signal: null, status: 7 },
      { failureReportedByChild: true },
    )).toThrow(ReportedChildExitError);

    try {
      assertSynchronousChildSuccess(
        { signal: null, status: 7 },
        { failureReportedByChild: true },
      );
    } catch (error) {
      expect(error).toMatchObject({ exitCode: 7 });
    }
  });

  it("forwards a child termination signal and aborts the current command", () => {
    const signalTarget = { pid: 123, kill: vi.fn() };

    expect(() => assertSynchronousChildSuccess(
      { signal: "SIGTERM", status: null },
      { signalTarget },
    )).toThrow(ForwardedChildSignalError);
    expect(signalTarget.kill).toHaveBeenCalledWith(123, "SIGTERM");
  });

  it("uses the caller's failure context for silent non-zero exits", () => {
    expect(() => assertSynchronousChildSuccess(
      { signal: null, status: 3 },
      { failureMessage: (exitCode) => `维护命令失败：exit=${exitCode}` },
    )).toThrow("维护命令失败：exit=3");
  });
});
