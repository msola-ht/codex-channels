import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const workflows = [
  "ci.yml",
  "publish.yml",
  "sync-published-readme.yml",
];

describe("commit verification workflows", () => {
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

  it("fetches the parent commit before verifying the rendered README", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/sync-published-readme.yml"),
      "utf8",
    );
    const prepareJob = workflow.slice(
      workflow.indexOf("  prepare:"),
      workflow.indexOf("  sync:"),
    );

    expect(prepareJob).toContain("fetch-depth: 2");
    expect(prepareJob.indexOf("fetch-depth: 2")).toBeLessThan(
      prepareJob.indexOf("npm run verify:commit"),
    );
  });
});
