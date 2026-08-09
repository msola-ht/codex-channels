import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  childProcessIsRunning,
  installProcessSignalHandlers,
  signalChildProcessGroup,
  signalChildProcesses,
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

  it("signals a detached Unix process group so descendants can clean up concurrently", () => {
    const child = { pid: 4321, exitCode: null, signalCode: null, kill: vi.fn() };
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      signalChildProcessGroup(child, "SIGTERM");

      if (process.platform === "win32") {
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      } else {
        expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");
        expect(child.kill).not.toHaveBeenCalled();
      }
    } finally {
      processKill.mockRestore();
    }
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
});
