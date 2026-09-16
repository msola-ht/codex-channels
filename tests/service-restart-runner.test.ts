import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  terminateChildProcess: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../runtime/process-lifecycle.mjs", () => ({
  terminateChildProcess: mocks.terminateChildProcess,
}));

const { restartAppServerService } = await import(
  "../src/bootstrap/service-restart-runner.js"
);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("restartAppServerService", () => {
  it("runs the packaged App Server restart command with the provided environment", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValueOnce(child);
    const environment = { PATH: "/usr/local/bin" };

    const result = restartAppServerService({ environment });
    child.emit("close", 0);

    await expect(result).resolves.toBeUndefined();
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/bin\/codexc\.mjs$/u), "service", "restart", "app-server"],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("reports the bounded stderr tail when the restart command fails", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValueOnce(child);
    const result = restartAppServerService();
    child.stdout.write("stdout detail");
    child.stderr.write(`${"x".repeat(4_100)}restart failed`);
    child.emit("close", 7);

    await expect(result).rejects.toThrow(
      `codexc service restart app-server 失败：exit=7 ${"x".repeat(3_986)}restart failed`,
    );
  });

  it("forwards child process startup errors", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValueOnce(child);
    const result = restartAppServerService();
    child.emit("error", new Error("spawn failed"));

    await expect(result).rejects.toThrow("spawn failed");
  });

  it("terminates the child process and rejects when restart times out", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    mocks.spawn.mockReturnValueOnce(child);
    mocks.terminateChildProcess.mockResolvedValueOnce(undefined);
    const result = restartAppServerService({ timeoutMs: 50 });
    const rejection = expect(result).rejects.toThrow(
      "codexc service restart app-server 超时",
    );

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(mocks.terminateChildProcess).toHaveBeenCalledWith(child);
  });

  it("reports child process cleanup failures after a timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    mocks.spawn.mockReturnValueOnce(child);
    mocks.terminateChildProcess.mockRejectedValueOnce(new Error("cleanup failed"));
    const result = restartAppServerService({ timeoutMs: 50 });
    const rejection = expect(result).rejects.toMatchObject({
      message: "codexc service restart app-server 超时且子进程树清理失败",
      cause: expect.objectContaining({ message: "cleanup failed" }),
    });

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
  });
});

function fakeChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
} {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
