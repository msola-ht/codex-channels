import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const workflows = [
  "ci.yml",
  "publish.yml",
];

describe("commit verification workflows", () => {
  it("runs CI for pull requests and manual checks without push duplication", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).not.toContain("  push:");
    expect(workflow).toContain("  pull_request:");
    expect(workflow).toContain("  workflow_dispatch:");
  });

  it.each(workflows)("installs WebUI dependencies before verification in %s", (name) => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows", name),
      "utf8",
    );
    const install = workflow.indexOf("npm ci --ignore-scripts --prefix webui");
    const verify = workflow.indexOf("npm run verify:commit");

    expect(install).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(install);
  });

  it("requires the release commit to contain the finalized README", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows", "publish.yml"),
      "utf8",
    );

    expect(workflow).toContain("node scripts/check-release-tag.mjs");
    expect(workflow).not.toContain("sync-published-readme.mjs");
  });
});
