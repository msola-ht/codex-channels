import { afterEach, expect, it, vi } from "vitest";
import { serviceDefinitions } from "../runtime/service-targets.mjs";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), services: [] as Array<{ target: string; windows: string }> }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", async () => ({ ...await vi.importActual<typeof import("node:fs")>("node:fs"), existsSync: () => false }));
vi.mock("../runtime/executable.mjs", () => ({ resolveExecutable: () => "fixture-pwsh" }));
vi.mock("../scripts/service-selection.mjs", () => ({ serviceControlDefinitions: () => mocks.services, serviceSnapshotHealthy: () => true }));
const { controlWindowsServices } = await import("../scripts/windows-service-control.mjs");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.clearAllMocks(); });

it.each(["model-relay", "gateway"])("aborts restart when %s cannot stop, without touching subsequent services", async failedTarget => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  mocks.services = ["model-relay", "gateway", "app-server"].map(target => serviceDefinitions.find(value => value.target === target)!);
  const failedIndex = mocks.services.findIndex(value => value.target === failedTarget);
  const calls: string[] = [];
  mocks.spawnSync.mockImplementation((_binary: string, args: string[]) => {
    const action = args[args.indexOf("-Action") + 1]!;
    const task = args[args.indexOf("-TaskName") + 1]!;
    calls.push(`${action}:${task}`);
    return { status: task === mocks.services[failedIndex]!.windows ? 9 : 0, stdout: "", stderr: "fixture failure" };
  });
  await expect(controlWindowsServices({ action: "restart", target: "all", definitionsDirectory: "/fixture", environment: {} }))
    .rejects.toThrow(`已中止重启：${failedTarget}`);
  expect(calls).toEqual(mocks.services.slice(0, failedIndex + 1).map(value => `stop:${value.windows}`));
});

it("retains best-effort stopping for an explicit stop-all request", async () => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  mocks.services = ["gateway", "app-server"].map(target => serviceDefinitions.find(value => value.target === target)!);
  const calls: string[] = [];
  mocks.spawnSync.mockImplementation((_binary: string, args: string[]) => {
    const task = args[args.indexOf("-TaskName") + 1]!;
    calls.push(task);
    return { status: 9, stdout: "", stderr: "fixture failure" };
  });
  await expect(controlWindowsServices({ action: "stop", target: "all", definitionsDirectory: "/fixture", environment: {} })).rejects.toThrow("服务停止部分失败");
  expect(calls).toEqual(mocks.services.map(value => value.windows));
});
