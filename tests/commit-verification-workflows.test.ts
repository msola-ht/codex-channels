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

  it("reports each verification stage duration and the total duration", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts", "verify-commit.mjs"),
      "utf8",
    );

    expect(script).toContain("formatDuration");
    expect(script).toContain("累计耗时");
    expect(script).toContain("总耗时");
  });

  it("keeps clean source installation outside the routine commit gate", () => {
    const packageDocument = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const verification = readFileSync(
      join(process.cwd(), "scripts", "verify-commit.mjs"),
      "utf8",
    );

    expect(packageDocument.scripts["test:package:tarball-prepared"]).toBe(
      "node scripts/smoke-package.mjs",
    );
    expect(packageDocument.scripts["test:package"]).toContain("smoke-source-prepare.mjs");
    expect(verification).toContain("test:package:tarball-prepared");
    expect(verification).not.toContain('args: ["run", "test:package:prepared"]');
    const publishWorkflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    expect(publishWorkflow).toContain("node scripts/smoke-source-prepare.mjs");
  });
});
