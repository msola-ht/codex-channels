import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

const workflows = [
  "ci.yml",
];

describe("commit verification workflows", () => {
  it.skipIf(process.platform === "win32").each([
    { failure: "", status: 0 },
    { failure: "run check", status: 17 },
    { failure: "run build -- --noCheck", status: 17 },
    { failure: "vitest", status: 17 },
  ])("checks types before emitting and stops dependent stages on $failure", ({ failure, status }) => {
    const directory = mkdtempSync(join(tmpdir(), "commit-gate-"));
    try {
      for (const child of ["scripts", "runtime", "bin", "webui", "node_modules/vitest"]) {
        mkdirSync(join(directory, child), { recursive: true });
      }
      for (const file of ["scripts/verify-commit.mjs", "runtime/executable.mjs"]) {
        copyFileSync(join(process.cwd(), file), join(directory, file));
      }
      const recorder = `
import { appendFileSync } from "node:fs";
const command = process.argv[1].endsWith("vitest.mjs") ? "vitest" : process.argv.slice(2).join(" ");
appendFileSync(process.env.VERIFY_EVENTS, command + "\\n");
if (command === process.env.VERIFY_FAIL) process.exit(17);
`;
      for (const command of ["git", "npm", "bash", "plutil"]) {
        writeFileSync(join(directory, "bin", command), `#!/usr/bin/env node\n${recorder}`, { mode: 0o755 });
      }
      writeFileSync(join(directory, "node_modules/vitest/vitest.mjs"), recorder);
      const eventsFile = join(directory, "events");
      const result = spawnSync(process.execPath, ["scripts/verify-commit.mjs"], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}${delimiter}${process.env.PATH ?? ""}`,
          VERIFY_EVENTS: eventsFile,
          VERIFY_FAIL: failure,
        },
      });
      expect(result.status, result.stderr).toBe(status);
      const events = readFileSync(eventsFile, "utf8").trim().split("\n");
      const check = events.indexOf("run check");
      const build = events.indexOf("run build -- --noCheck");
      const test = events.indexOf("vitest");
      const pack = events.indexOf("run test:package:tarball-prepared");
      expect(check).toBeGreaterThan(-1);
      expect(events).not.toContain("test");
      if (failure === "run check") {
        expect(build).toBe(-1);
      } else {
        expect(build).toBeGreaterThan(check);
        expect(events.filter((event) => event === "run build -- --noCheck")).toHaveLength(1);
      }
      if (failure === "run check" || failure === "run build -- --noCheck") {
        expect(test).toBe(-1);
      } else {
        expect(test).toBeGreaterThan(build);
      }
      if (failure) {
        expect(pack).toBe(-1);
      } else {
        expect(pack).toBeGreaterThan(test);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it("keeps dictionary validation without automatic translation reporting", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    const verify = readFileSync(join(process.cwd(), "scripts/verify-commit.mjs"), "utf8");
    expect(workflow).not.toContain("i18n-report:");
    expect(workflow).not.toContain("i18n:report");
    expect(workflow).toContain("npm run verify:commit");
    expect(workflow).not.toMatch(/contents:\s*write/u);
    expect(verify).toContain('args: ["run", "i18n:check"]');
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
