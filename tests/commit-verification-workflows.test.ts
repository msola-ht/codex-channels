import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const workflows = [
  "ci.yml",
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

  it("runs Windows Desktop contracts by file without test-name filters", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("tests/windows-desktop-app-command.test.ts");
    expect(workflow).toContain("tests/desktop-app-bridge.test.ts");
    expect(workflow).not.toMatch(/(?:^|\s)-t(?:\s|$)/u);
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

  it("prevents npm publication while retaining local package installation", () => {
    const packageDocument = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      private?: boolean;
      publishConfig?: unknown;
    };
    expect(packageDocument.private).toBe(true);
    expect(packageDocument.publishConfig).toBeUndefined();
    const directory = join(process.cwd(), ".github", "workflows");
    for (const name of readdirSync(directory).filter((entry) => /\.ya?ml$/u.test(entry))) {
      const workflow = readFileSync(join(directory, name), "utf8");
      expect(workflow, name).not.toMatch(/\bnpm\s+publish\b/u);
      expect(workflow, name).not.toMatch(/id-token:\s*write/u);
    }
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
  });
});
