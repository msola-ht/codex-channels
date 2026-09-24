import { describe, expect, it, vi } from "vitest";
import { runCliMenu, runServiceMenu } from "../scripts/cli-menu.mjs";
import { ForwardedChildSignalError, ReportedChildExitError } from "../runtime/process-lifecycle.mjs";

function fixture(values: unknown[], confirmations: unknown[] = []) {
  return {
    intro: vi.fn(),
    isCancel: (value: unknown) => typeof value === "symbol",
    select: vi.fn(async (options: Record<string, unknown>) => { void options; return values.shift() ?? "cancel"; }),
    confirm: vi.fn(async (options: Record<string, unknown>) => { void options; return confirmations.shift(); }),
  };
}

describe("CLI navigation", () => {
  it("returns to the main menu after commands complete or report failure", async () => {
    const runCommand = vi.fn().mockRejectedValueOnce(new ReportedChildExitError(1)).mockResolvedValue(undefined);
    const prompts = fixture(["doctor", "work", "cancel"]);
    await runCliMenu({ prompts, runCommand });
    expect(runCommand.mock.calls).toEqual([[["doctor"]], [["work"]]]);
    expect(prompts.select).toHaveBeenCalledTimes(3);
  });

  it("does not turn a forwarded process signal into another prompt", async () => {
    const signal = new ForwardedChildSignalError("SIGINT");
    const prompts = fixture(["remote"]);
    await expect(runCliMenu({ prompts, runCommand: async () => { throw signal; } })).rejects.toBe(signal);
    expect(prompts.select).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch cancelled or unsupported menu values", async () => {
    const runCommand = vi.fn();
    await runCliMenu({ prompts: fixture([Symbol("cancel")]), runCommand });
    await expect(runCliMenu({ prompts: fixture(["arbitrary"]), runCommand })).rejects.toThrow("未知");
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("service menu", () => {
  it("uses explicit targets, bounded logs and the existing command boundary", async () => {
    const prompts = fixture(["status", "all", "restart", "webui", "logs", "gateway", "reload", "cancel"]);
    const runCommand = vi.fn();
    await runServiceMenu({ prompts, runCommand });
    expect(runCommand.mock.calls).toEqual([
      [["status", "all"]], [["restart", "webui"]], [["logs", "gateway", "--lines", "100"]], [["reload"]],
    ]);
    expect(prompts.select.mock.calls[1]?.[0]).toMatchObject({
      options: expect.arrayContaining([expect.objectContaining({ value: "all", hint: expect.stringContaining("不含 WebUI") })]),
    });
  });

  it("returns from target selection and requires explicit uninstall confirmation", async () => {
    const prompts = fixture(["stop", "back", "uninstall", "uninstall", "cancel"], [false, true]);
    const runCommand = vi.fn();
    await runServiceMenu({ prompts, runCommand });
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(["uninstall"]);
    expect(prompts.confirm.mock.calls[0]?.[0]).toMatchObject({ initialValue: false });
  });

  it("remains available after a reported failure", async () => {
    const runCommand = vi.fn().mockRejectedValueOnce(new ReportedChildExitError(1)).mockResolvedValue(undefined);
    await runServiceMenu({ prompts: fixture(["status", "all", "logs", "gateway", "cancel"]), runCommand });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
