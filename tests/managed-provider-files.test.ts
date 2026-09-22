import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ path: "" }));
vi.mock("../runtime/private-file.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/private-file.mjs")>();
  return {
    ...actual,
    writePrivateFileAtomic: async (...args: Parameters<typeof actual.writePrivateFileAtomic>) => {
      if (args[0] === failure.path) throw new Error("injected restore failure");
      return actual.writePrivateFileAtomic(...args);
    },
  };
});

import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { restoreProviderFileSnapshots, snapshotProviderFiles } from "../scripts/managed-provider-files.mjs";

const directories: string[] = [];
afterEach(() => {
  failure.path = "";
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "provider-rollback-"));
  directories.push(directory);
  const paths = [join(directory, "first.json"), join(directory, "second.json")];
  for (const path of paths) writePrivateFileAtomicSync(path, "before");
  const snapshots = snapshotProviderFiles(paths);
  for (const path of paths) writePrivateFileAtomicSync(path, "after");
  return { paths, snapshots, guards: snapshotProviderFiles(paths) };
}

describe("managed Provider file rollback", () => {
  it("restores remaining files after one restoration fails", async () => {
    const { paths, snapshots, guards } = fixture();
    failure.path = paths[0]!;
    await expect(restoreProviderFileSnapshots(snapshots, guards)).rejects.toThrow("回滚未完成");
    expect(readFileSync(paths[0]!, "utf8")).toBe("after");
    expect(readFileSync(paths[1]!, "utf8")).toBe("before");
  });

  it("rejects rollback when files have changed outside the transaction", async () => {
    const { paths, snapshots, guards } = fixture();
    writePrivateFileAtomicSync(paths[0]!, "external change");
    await expect(restoreProviderFileSnapshots(snapshots, guards)).rejects.toThrow("事务期间发生变化");
    expect(readFileSync(paths[0]!, "utf8")).toBe("external change");
    expect(readFileSync(paths[1]!, "utf8")).toBe("after");
  });
});
