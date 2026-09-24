import { describe, expect, it, vi } from "vitest";

import { ReportedChildExitError } from "../runtime/process-lifecycle.mjs";
import { runCleanupMenu } from "../scripts/cleanup-menu.mjs";

function fixture(actions: unknown[], texts: unknown[] = [], confirms: unknown[] = []) {
  const cancelled = Symbol("cancel");
  return {
    cancelled,
    prompts: {
      intro: vi.fn(), cancel: vi.fn(),
      isCancel: (value: unknown) => value === cancelled,
      select: vi.fn(async () => actions.shift() ?? "cancel"),
      text: vi.fn(async () => texts.shift()),
      confirm: vi.fn(async () => confirms.shift()),
    },
    runSessionCleanup: vi.fn(),
    runTrafficCleanup: vi.fn(),
    runDatabaseCommand: vi.fn(),
    readStorage: () => ({ retention_days: 30, max_rows: 5000 }),
  };
}

describe("unified cleanup menu", () => {
  it("returns to the menu after a failed preview without deleting traffic", async () => {
    const options = fixture(["traffic", "cancel"]);
    options.runTrafficCleanup.mockRejectedValueOnce(new ReportedChildExitError(1));
    await runCleanupMenu(options);
    expect(options.runTrafficCleanup).toHaveBeenCalledExactlyOnceWith([]);
    expect(options.prompts.confirm).not.toHaveBeenCalled();
    expect(options.prompts.select).toHaveBeenCalledTimes(2);
  });

  it("collects session parameters without another action menu and returns to the main menu", async () => {
    const options = fixture(["sessions", "cancel"], ["3", "7"]);
    await runCleanupMenu(options);
    expect(options.runSessionCleanup).toHaveBeenCalledWith(["3", "--idle-days", "7", "--confirm"]);
    expect(options.prompts.select).toHaveBeenCalledTimes(2);
  });

  it("previews traffic before asking for destructive confirmation", async () => {
    const options = fixture(["traffic"], [], [true]);
    await runCleanupMenu(options);
    expect(options.runTrafficCleanup.mock.calls).toEqual([[[]], [["--confirm"]]]);
    expect(options.runTrafficCleanup.mock.invocationCallOrder[0]).toBeLessThan(options.prompts.confirm.mock.invocationCallOrder[0]!);
    expect(options.prompts.confirm.mock.invocationCallOrder[0]).toBeLessThan(options.runTrafficCleanup.mock.invocationCallOrder[1]!);
  });

  it("reuses metrics cleanup and reset workflows", async () => {
    const options = fixture(["cleanup", "reset"], ["30", "5000"], [true, true]);
    await runCleanupMenu(options);
    expect(options.runDatabaseCommand.mock.calls).toEqual([
      [["cleanup-restart", "--keep-days", "30", "--max-rows", "5000", "--vacuum"]],
      [["reset"]],
    ]);
  });

  it("preserves the exact Provider ID when confirmed", async () => {
    const options = fixture(["prune"], [" OpenAI "], [true]);
    await runCleanupMenu(options);
    expect(options.runDatabaseCommand).toHaveBeenCalledWith(["prune", "OpenAI"]);
  });

  it("does not mutate when confirmations are declined", async () => {
    const options = fixture(["traffic", "prune", "reset"], ["openai"], [false, false, false]);
    await runCleanupMenu(options);
    expect(options.runTrafficCleanup.mock.calls).toEqual([[[]]]);
    expect(options.runDatabaseCommand).not.toHaveBeenCalled();
  });

  it("returns from cancelled input without executing a command", async () => {
    const texts: unknown[] = [];
    const options = fixture(["prune", "sessions", "cleanup"], texts);
    texts.push(options.cancelled, options.cancelled, options.cancelled);
    await runCleanupMenu(options);
    expect(options.runDatabaseCommand).not.toHaveBeenCalled();
    expect(options.runSessionCleanup).not.toHaveBeenCalled();
  });

  it("reports a failed traffic preview without offering deletion and returns to the menu", async () => {
    const options = fixture(["traffic"]);
    options.runTrafficCleanup.mockRejectedValue(new Error("preview failed"));
    await expect(runCleanupMenu(options)).resolves.toBeUndefined();
    expect(options.runTrafficCleanup).toHaveBeenCalledExactlyOnceWith([]);
    expect(options.prompts.select).toHaveBeenCalledTimes(2);
    expect(options.prompts.confirm).not.toHaveBeenCalled();
  });

  it("rejects unknown actions", async () => {
    await expect(runCleanupMenu(fixture(["unknown"]))).rejects.toThrow("未知清理项目");
  });
});
