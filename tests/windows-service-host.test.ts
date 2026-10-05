import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), start: vi.fn(), close: vi.fn(), terminate: vi.fn(), open: vi.fn(), secure: vi.fn(), closeFile: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ openSync: mocks.open, closeSync: mocks.closeFile }));
vi.mock("../runtime/private-file.mjs", () => ({
  securePrivateFileSync: mocks.secure,
  readPrivateFileSync: () => JSON.stringify({ version: 1, target: "gateway", displayName: "fixture", nodeBinary: "node", arguments: [], workingDirectory: "/fixture", environment: {}, controlPath: "/fixture/control", stdoutLog: "out", stderrLog: "err" }),
}));
vi.mock("../runtime/private-ipc.mjs", () => ({ PrivateIpcServer: class { start = mocks.start; close = mocks.close; } }));
vi.mock("../runtime/process-lifecycle.mjs", () => ({
  childProcessIsRunning: (child?: { exitCode: number | null }) => child?.exitCode === null,
  installProcessSignalHandlers: () => () => {},
  terminateChildProcess: mocks.terminate,
}));
import { runWindowsServiceHost } from "../scripts/windows-service-host.mjs";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let child: EventEmitter & { exitCode: number | null; signalCode: null; connected: boolean };
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: false });
  mocks.spawn.mockReturnValue(child);
  mocks.open.mockReturnValueOnce(10).mockReturnValueOnce(11);
  mocks.start.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.terminate.mockImplementation(async () => { child.exitCode = 0; child.emit("exit", 0, null); });
});
afterEach(() => { Object.defineProperty(process, "platform", platform); });

it.each(["exit", "error"])("observes child %s while the control endpoint is starting", async event => {
  mocks.start.mockImplementation(async () => {
    child.exitCode = 1;
    if (event === "exit") child.emit("exit", 1, null);
    else child.emit("error", new Error("spawn failed"));
  });
  await expect(runWindowsServiceHost("fixture.json")).rejects.toThrow(event === "exit" ? "意外退出" : "spawn failed");
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.closeFile.mock.calls).toEqual([[10], [11]]);
});

it("terminates the child when the control endpoint fails", async () => {
  mocks.start.mockRejectedValue(new Error("endpoint unavailable"));
  await expect(runWindowsServiceHost("fixture.json")).rejects.toThrow("endpoint unavailable");
  expect(mocks.terminate).toHaveBeenCalledWith(child);
  expect(child.exitCode).toBe(0);
  expect(mocks.closeFile.mock.calls).toEqual([[10], [11]]);
});

it("closes the endpoint and logs even when child cleanup fails", async () => {
  mocks.start.mockRejectedValue(new Error("endpoint unavailable"));
  mocks.terminate.mockRejectedValue(new Error("termination failed"));
  await expect(runWindowsServiceHost("fixture.json")).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: "endpoint unavailable" }), expect.objectContaining({ message: "termination failed" })],
  });
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.closeFile.mock.calls).toEqual([[10], [11]]);
});

it("closes both log handles when the second ACL check fails, before spawning", async () => {
  mocks.secure.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("ACL failed"); });
  await expect(runWindowsServiceHost("fixture.json")).rejects.toThrow("ACL failed");
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.closeFile.mock.calls).toEqual([[11], [10]]);
});
