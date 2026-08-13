import { describe, expect, it, vi } from "vitest";

import { runMetricsMenu } from "../scripts/metrics-menu.mjs";

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

    await runMetricsMenu({
      prompts,
      readStorage: () => ({ retention_days: 90, max_rows: 100_000 }),
      runDatabaseCommand,
      runMetricsCommand: vi.fn(),
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
    isCancel: () => false,
    select: vi.fn(async () => selects.shift()),
    text: vi.fn(async () => texts.shift()),
    confirm: vi.fn(async () => confirms.shift()),
  };
}
