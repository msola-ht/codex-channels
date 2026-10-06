import { describe, expect, it, vi } from "vitest";
import { runMaintenanceServices, type MaintenanceTarget } from "../scripts/maintenance-services.mjs";
import { runServiceCommand } from "../scripts/service-command.mjs";

vi.mock("../scripts/service-command.mjs", () => ({ runServiceCommand: vi.fn(async () => {}) }));

function fixture() {
  return {
    prompts: { confirm: vi.fn(async () => true), cancel: vi.fn(), isCancel: () => false },
    targets: ["gateway", "relay", "app-server"] as MaintenanceTarget[],
    isRunning: vi.fn(async (target: MaintenanceTarget) => target !== "relay"),
    runService: vi.fn<(action: "stop" | "start", target: MaintenanceTarget) => Promise<void>>(async () => {}),
    run: vi.fn(async () => "done"),
  };
}

describe("maintenance service lifecycle", () => {
  it("maps maintenance targets to canonical CLI targets through the default adapter", async () => {
    const { prompts, targets, isRunning, run } = fixture();
    isRunning.mockResolvedValue(true);
    await runMaintenanceServices({ prompts, targets, isRunning, run });
    expect(vi.mocked(runServiceCommand).mock.calls).toEqual([
      [["stop", "gateway"]], [["stop", "relay"]], [["stop", "appserver"]],
      [["start", "appserver"]], [["start", "relay"]], [["start", "gateway"]],
    ]);
  });

  it("restores only running services in reverse order", async () => {
    const options = fixture();
    expect(await runMaintenanceServices(options)).toBe("done");
    expect(options.runService.mock.calls).toEqual([
      ["stop", "gateway"], ["stop", "app-server"], ["start", "app-server"], ["start", "gateway"],
    ]);
  });

  it("restores attempted stops without running cleanup when a stop fails", async () => {
    const options = fixture();
    const error = new Error("stop failed");
    options.runService.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(runMaintenanceServices(options)).rejects.toBe(error);
    expect(options.run).not.toHaveBeenCalled();
    expect(options.runService.mock.calls.slice(2)).toEqual([["start", "app-server"], ["start", "gateway"]]);
  });

  it("continues restoration after a failure and preserves the operation error", async () => {
    const options = fixture();
    const operationError = new Error("operation failed");
    const recoveryError = new Error("recovery failed");
    options.run.mockRejectedValueOnce(operationError);
    options.runService.mockImplementation(async action => { if (action === "start") throw recoveryError; });
    await expect(runMaintenanceServices(options)).rejects.toMatchObject({
      errors: [operationError, recoveryError, recoveryError],
      message: expect.stringContaining("codexc start appserver；codexc start gateway"),
    });
    expect(options.runService).toHaveBeenLastCalledWith("start", "gateway");
  });

  it("checks all states before stopping anything", async () => {
    const options = fixture();
    options.isRunning.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("unknown status"));
    await expect(runMaintenanceServices(options)).rejects.toThrow("unknown status");
    expect(options.prompts.confirm).not.toHaveBeenCalled();
    expect(options.runService).not.toHaveBeenCalled();
  });

  it("does not stop or run when interruption is declined", async () => {
    const options = fixture();
    options.prompts.confirm.mockResolvedValueOnce(false);
    await runMaintenanceServices(options);
    expect(options.runService).not.toHaveBeenCalled();
    expect(options.run).not.toHaveBeenCalled();
  });
});
