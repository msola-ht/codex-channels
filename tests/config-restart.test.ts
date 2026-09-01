import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  resolveExecutableInvocation: vi.fn(() => ({
    file: "C:/Users/test/AppData/Roaming/npm/codexc.cmd",
    args: ["service", "restart", "gateway"],
    windowsVerbatimArguments: true,
  })),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("../runtime/executable.mjs", () => ({
  resolveExecutableInvocation: mocks.resolveExecutableInvocation,
}));

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
const { restartServiceTarget } = await import("../scripts/config.mjs");

describe("config service restart", () => {
  it("resolves the codexc Windows shim before invoking the restart command", async () => {
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(null, "restarted", "");
      return {};
    });

    const environment = { PATH: "C:/Users/test/AppData/Roaming/npm" };
    await restartServiceTarget("gateway", environment);

    expect(mocks.resolveExecutableInvocation).toHaveBeenCalledWith(
      "codexc",
      ["service", "restart", "gateway"],
      environment,
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      "C:/Users/test/AppData/Roaming/npm/codexc.cmd",
      ["service", "restart", "gateway"],
      expect.objectContaining({
        env: environment,
        windowsVerbatimArguments: true,
      }),
      expect.any(Function),
    );
  });
});
