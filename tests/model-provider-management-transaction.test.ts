import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withModelProviderManagementTransaction } from "../scripts/model-provider-management-transaction.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model Provider management transaction", () => {
  it("serializes concurrent management operations", async () => {
    const environment = fixtureEnvironment();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = withModelProviderManagementTransaction(environment, async () => {
      events.push("first-enter");
      firstEntered();
      await firstMayFinish;
      events.push("first-exit");
    });
    await firstDidEnter;
    const second = withModelProviderManagementTransaction(environment, async () => {
      events.push("second-enter");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first-enter"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("allows a nested operation in the same transaction", async () => {
    const environment = fixtureEnvironment();
    const events: string[] = [];

    await withModelProviderManagementTransaction(environment, async () => {
      events.push("outer");
      await withModelProviderManagementTransaction(environment, async () => {
        events.push("inner");
      });
    });

    expect(events).toEqual(["outer", "inner"]);
  });
});

function fixtureEnvironment() {
  const home = mkdtempSync(join(tmpdir(), "codexc-provider-transaction-"));
  temporaryDirectories.push(home);
  return { ...process.env, CODEX_CONNECT_HOME: home };
}
