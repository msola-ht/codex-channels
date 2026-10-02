import { describe, expect, it, vi } from "vitest";

import { runSessionCleanupMenu } from "../scripts/session-menu.mjs";

vi.mock("../scripts/service-status.mjs", () => ({
  inspectManagedServiceStatus: () => ({ services: [{ target: "gateway", running: false, state: "inactive/dead" }] }),
}));

describe("session menu", () => {
  function maintenance(accepted: unknown = true) {
    const values = ["3", ""];
    return {
      prompts: {
        intro: vi.fn(), select: vi.fn(), cancel: vi.fn(),
        text: vi.fn(async () => values.shift()), confirm: vi.fn(async () => accepted),
        isCancel: (value: unknown) => typeof value === "symbol",
      },
      gatewayRunning: vi.fn(async () => true),
      runService: vi.fn<(action: "start" | "stop") => Promise<void>>(async () => undefined),
      runCleanup: vi.fn<(args: string[]) => Promise<string>>(async () => "done"),
    };
  }

  it("stops only Gateway before scanning and restores it afterwards", async () => {
    const options = maintenance();
    expect(await runSessionCleanupMenu(options)).toBe("done");
    expect(options.prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(options.runService.mock.calls).toEqual([["stop"], ["start"]]);
    expect(options.runService.mock.invocationCallOrder[0]).toBeLessThan(options.runCleanup.mock.invocationCallOrder[0]!);
    expect(options.runCleanup.mock.invocationCallOrder[0]).toBeLessThan(options.runService.mock.invocationCallOrder[1]!);
  });

  it.each([false, Symbol("cancel")])("does nothing when interruption is declined: %s", async accepted => {
    const options = maintenance(accepted);
    await runSessionCleanupMenu(options);
    expect(options.runService).not.toHaveBeenCalled();
    expect(options.runCleanup).not.toHaveBeenCalled();
  });

  it("keeps an initially stopped Gateway stopped", async () => {
    const options = maintenance();
    options.gatewayRunning.mockResolvedValue(false);
    await runSessionCleanupMenu(options);
    expect(options.runCleanup).toHaveBeenCalled();
    expect(options.runService).not.toHaveBeenCalled();
    expect(options.prompts.confirm).not.toHaveBeenCalled();
  });

  it.each(["stop", "cleanup"])("restores Gateway after %s fails", async stage => {
    const options = maintenance();
    const error = new Error("operation failed");
    if (stage === "stop") options.runService.mockRejectedValueOnce(error);
    else options.runCleanup.mockRejectedValueOnce(error);
    await expect(runSessionCleanupMenu(options)).rejects.toBe(error);
    expect(options.runService.mock.calls).toEqual([["stop"], ["start"]]);
    if (stage === "stop") expect(options.runCleanup).not.toHaveBeenCalled();
  });

  it("preserves both cleanup and restoration failures", async () => {
    const options = maintenance();
    const cleanupError = new Error("cleanup failed");
    const startError = new Error("start failed");
    options.runCleanup.mockRejectedValueOnce(cleanupError);
    options.runService.mockResolvedValueOnce(undefined).mockRejectedValueOnce(startError);
    await expect(runSessionCleanupMenu(options)).rejects.toMatchObject({ errors: [cleanupError, startError],
      message: expect.stringContaining("codexc service start gateway") });
  });

  it("does not proceed when service status cannot be read", async () => {
    const options = maintenance();
    options.gatewayRunning.mockRejectedValueOnce(new Error("status unavailable"));
    await expect(runSessionCleanupMenu(options)).rejects.toThrow("status unavailable");
    expect(options.runService).not.toHaveBeenCalled();
    expect(options.runCleanup).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("allows an empty idle filter: %s", async (idleInput) => {
    const runCleanup = vi.fn();
    let step = 0;
    const prompts = {
      intro: vi.fn(), confirm: vi.fn(), select: vi.fn(), cancel: vi.fn(), isCancel: () => false,
      text: vi.fn(async (options: Record<string, unknown>) => {
        const validate = options.validate as (value: string | undefined) => string | undefined;
        if (step++ === 0) {
          expect(validate(undefined)).toBe("请输入 0 到 10000 的整数");
          expect(validate("3")).toBeUndefined();
          return "3";
        }
        // Clack validates the untouched value before finalizing it as "".
        expect(validate(idleInput)).toBeUndefined();
        for (const value of ["0", "-1", "1.5", "36501", "abc"]) expect(validate(value)).toBeTypeOf("string");
        for (const value of ["1", " 7 ", "36500"]) expect(validate(value)).toBeUndefined();
        return idleInput ?? "";
      }),
    };
    await runSessionCleanupMenu({ prompts, runCleanup });
    expect(runCleanup).toHaveBeenCalledExactlyOnceWith(["3", "--confirm"]);
  });

  it.each([0, 1])("does not run cleanup when prompt %s is cancelled", async (cancelAt) => {
    const cancelled = Symbol("cancel");
    const values = cancelAt === 0 ? [cancelled] : ["3", cancelled];
    const runCleanup = vi.fn();
    const prompts = {
      intro: vi.fn(), confirm: vi.fn(), select: vi.fn(), cancel: vi.fn(),
      isCancel: (value: unknown) => value === cancelled,
      text: vi.fn(async () => values.shift()),
    };
    await runSessionCleanupMenu({ prompts, runCleanup });
    expect(runCleanup).not.toHaveBeenCalled();
    expect(prompts.cancel).toHaveBeenCalledWith("已取消");
  });

  it("collects cleanup settings and delegates to the CLI", async () => {
    const runCleanup = vi.fn(async () => undefined);
    const values = ["3", "7"];
    const textOptions: Array<Record<string, unknown>> = [];
    const prompts = {
      intro: vi.fn(), confirm: vi.fn(),
      select: vi.fn(async () => values.shift()),
      text: vi.fn(async (options: Record<string, unknown>) => {
        textOptions.push(options);
        return values.shift();
      }),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runSessionCleanupMenu({ prompts, runCleanup });

    expect(runCleanup).toHaveBeenCalledWith(["3", "--idle-days", "7", "--confirm"]);
    expect(textOptions[0]).toMatchObject({ initialValue: "3" });
  });
});
