import { describe, expect, it, vi } from "vitest";

import { runMetricsMenu, runMetricsMaintenanceMenu } from "../scripts/metrics-menu.mjs";

describe("metrics menu", () => {
  it("routes status through the database command boundary", async () => {
    const runDatabaseCommand = vi.fn();
    const runMetricsCommand = vi.fn();
    const prompts = promptFixture({ selects: ["status"] });

    await runMetricsMenu({ prompts, runDatabaseCommand, runMetricsCommand });

    expect(runDatabaseCommand).toHaveBeenCalledWith(["status"]);
    expect(runMetricsCommand).not.toHaveBeenCalled();
  });

  it("collects cleanup policy before requesting a managed restart", async () => {
    const runDatabaseCommand = vi.fn();
    const prompts = promptFixture({
      selects: ["cleanup"],
      texts: ["30", "5000"],
      confirms: [true],
    });

    await runMetricsMaintenanceMenu("cleanup", {
      prompts,
      readStorage: () => ({ retention_days: 90, max_rows: 100_000 }),
      runDatabaseCommand,
    });

    expect(runDatabaseCommand).toHaveBeenCalledWith([
      "cleanup-restart",
      "--keep-days",
      "30",
      "--max-rows",
      "5000",
      "--vacuum",
    ]);
  });
  it("offers query actions without duplicate maintenance entries and returns after each query", async () => {
    const prompts = promptFixture({ selects: ["threads", "7d", "json", "quota", "30d", "markdown", "status", "cancel"] });
    const runDatabaseCommand = vi.fn();
    const runMetricsCommand = vi.fn();
    await runMetricsMenu({ prompts, runDatabaseCommand, runMetricsCommand });
    expect(runMetricsCommand).toHaveBeenCalledExactlyOnceWith(["threads", "--range", "7d", "--format", "json"]);
    expect(runDatabaseCommand.mock.calls).toEqual([
      [["quota", "--range", "30d", "--format", "markdown"]], [["status"]],
    ]);
    const options = prompts.select.mock.calls[0]?.[0]?.options as Array<{ value: string }>;
    expect(options.map((option) => option.value)).not.toContain("cleanup");
    expect(options.map((option) => option.value)).not.toContain("reset");
  });

  it("cancels a query without dispatching it and still permits another action", async () => {
    const cancelled = Symbol("cancel");
    const prompts = promptFixture({ selects: ["threads", cancelled, "status", "cancel"] });
    const runDatabaseCommand = vi.fn();
    const runMetricsCommand = vi.fn();
    await runMetricsMenu({ prompts, runDatabaseCommand, runMetricsCommand });
    expect(runMetricsCommand).not.toHaveBeenCalled();
    expect(runDatabaseCommand).toHaveBeenCalledExactlyOnceWith(["status"]);
  });

  it("awaits asynchronous query completion before showing the next menu", async () => {
    const prompts = promptFixture({ selects: ["status", "cancel"] });
    let complete!: () => void;
    const runDatabaseCommand = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const task = runMetricsMenu({ prompts, runDatabaseCommand, runMetricsCommand: vi.fn() });
    await vi.waitFor(() => expect(runDatabaseCommand).toHaveBeenCalledTimes(1));
    expect(prompts.select).toHaveBeenCalledTimes(1);
    complete();
    await task;
    expect(prompts.select).toHaveBeenCalledTimes(2);
  });

});

function promptFixture({
  selects = [],
  texts = [],
  confirms = [],
}: {
  selects?: unknown[];
  texts?: unknown[];
  confirms?: unknown[];
}) {
  return {
    intro: vi.fn(),
    cancel: vi.fn(),
    isCancel: (value: unknown) => typeof value === "symbol",
    select: vi.fn(async (options: Record<string, unknown>) => { void options; return selects.shift() ?? "cancel"; }),
    text: vi.fn(async () => texts.shift()),
    confirm: vi.fn(async () => confirms.shift()),
  };
}
