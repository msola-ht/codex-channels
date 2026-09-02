import { describe, expect, it, vi } from "vitest";

import { runSessionMenu } from "../scripts/session-menu.mjs";

describe("session menu", () => {
  it("collects cleanup settings and delegates to the CLI", async () => {
    const runCleanup = vi.fn(async () => undefined);
    const values = ["cleanup", "3", "7"];
    const textOptions: Array<Record<string, unknown>> = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn(async () => values.shift()),
      text: vi.fn(async (options: Record<string, unknown>) => {
        textOptions.push(options);
        return values.shift();
      }),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runSessionMenu({ prompts, runCleanup });

    expect(runCleanup).toHaveBeenCalledWith(["3", "--idle-days", "7", "--confirm"]);
    expect(textOptions[0]).toMatchObject({ initialValue: "3" });
  });
});
