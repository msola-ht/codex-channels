import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

// @ts-expect-error JavaScript verification entry points have no declaration file.
import { createVerificationPlan } from "../scripts/verify-commit.mjs";
// @ts-expect-error JavaScript verification entry points have no declaration file.
import { parseChangedFiles, verificationScope } from "../scripts/verification-scope.mjs";

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
      for (const file of ["scripts/verify-commit.mjs", "scripts/verification-scope.mjs", "scripts/run-upgrade-validation.mjs", "runtime/executable.mjs"]) {
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
      const result = spawnSync(process.execPath, ["scripts/verify-commit.mjs", "--ci"], {
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
      }
      expect(pack).toBe(-1);
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
    const verify = workflow.indexOf("npm run verify:ci");

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
    expect(workflow).toContain("npm run verify:ci");
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
    const ciPlan = createVerificationPlan([], { ci: true });
    expect(ciPlan.checks.some((check: { name: string }) => /安装|合同/u.test(check.name))).toBe(false);
    expect(verification).toContain("test:package:tarball-prepared");
    expect(verification).not.toContain('args: ["run", "test:package:prepared"]');
  });

  it("runs specialized CI checks only after successful shared scope analysis", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("scripts/verification-scope.mjs");
    expect(workflow).toContain("github.event.pull_request.base.sha");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("EVENT_NAME === 'workflow_dispatch'");
    expect(workflow).toContain("needs.changes.outputs.package == 'true'");
    expect(workflow).toContain("needs.changes.outputs.appServer == 'true'");
    expect(workflow.match(/if: needs\.changes\.result != 'success'/gu)).toHaveLength(2);
    expect(workflow.match(/if: always\(\)/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps documentation checks small and unrelated suites out of test-only commits", () => {
    const docsPlan = createVerificationPlan([{ status: "M", path: "docs/display.md" }]);
    expect(docsPlan.checks.map((check: { name: string }) => check.name)).toEqual(["文档与索引"]);
    const testPlan = createVerificationPlan([{ status: "A", path: "tests/new-behavior.test.ts" }]);
    const testCheck = testPlan.checks.find((check: { name: string }) => check.name === "受影响测试");
    expect(testCheck.args).toContain(resolve("tests/new-behavior.test.ts"));
    expect(testCheck.args).not.toContain(resolve("tests/codexc-cli-doctor.test.ts"));
  });

  it("includes dynamic readers, their helper consumers and compiled inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "commit-related-"));
    try {
      mkdirSync(join(root, "tests/support"), { recursive: true });
      writeFileSync(join(root, "tests/cli.test.ts"), 'import { spawnSync } from "node:child_process";');
      writeFileSync(join(root, "tests/support/files.ts"), 'import { readFile } from "node:fs/promises";');
      writeFileSync(join(root, "tests/dynamic.test.ts"), "await import(modulePath);");
      writeFileSync(join(root, "tests/ordinary.test.ts"), 'import { expect } from "vitest";');
      const plan = createVerificationPlan([{ status: "M", path: "src/delivery/queue.ts" }], { root });
      const related = plan.checks.find((check: { name: string }) => check.name === "受影响测试");
      for (const path of ["src/delivery/queue.ts", "dist/delivery/queue.js", "tests/cli.test.ts", "tests/support/files.ts", "tests/dynamic.test.ts"]) {
        expect(related.args).toContain(join(root, path));
      }
      expect(related.args).not.toContain(join(root, "tests/ordinary.test.ts"));
      const names = plan.checks.map((check: { name: string }) => check.name);
      expect(names.indexOf("Gateway 构建")).toBeLessThan(names.indexOf("受影响测试"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("selects real consumers of dynamically launched test fixtures", () => {
    const path = "tests/fixtures/mcp-tool-approval-server.mjs";
    const plan = createVerificationPlan([{ status: "M", path }]);
    const related = plan.checks.find((check: { name: string }) => check.name === "受影响测试");
    expect(related.args).toContain(resolve("tests/real-app-server-isolated-state.test.ts"));
    expect(verificationScope([{ status: "M", path }]).appServer).toBe(true);
    expect(plan.checks.some((check: { name: string }) => check.name === "真实 App Server 合同")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("executes graph, compiled and implicit helper boundaries without unrelated suites", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "commit-vitest-related-")));
    try {
      for (const path of ["tests/support", "src/delivery", "dist/delivery"]) mkdirSync(join(root, path), { recursive: true });
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
      writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["tests/**/*.test.ts"] } };');
      writeFileSync(join(root, "src/delivery/queue.ts"), "export const value = 2;");
      writeFileSync(join(root, "dist/delivery/queue.js"), "export const value = 2;");
      const assertion = 'import { it, expect } from "vitest"; it("selected", () => expect(value).toBe(2));';
      writeFileSync(join(root, "tests/source.test.ts"), `import { value } from "../src/delivery/queue.ts"; ${assertion}`);
      writeFileSync(join(root, "tests/compiled.test.ts"), `import { value } from "../dist/delivery/queue.js"; ${assertion}`);
      writeFileSync(join(root, "tests/support/files.ts"), 'import { existsSync } from "node:fs"; export const value = existsSync(process.cwd()) ? 2 : 0;');
      writeFileSync(join(root, "tests/helper.test.ts"), `import { value } from "./support/files.ts"; ${assertion}`);
      writeFileSync(join(root, "tests/cli.test.ts"), `import { spawnSync } from "node:child_process"; const value = spawnSync(process.execPath, ["-e", "process.exit(0)"]).status === 0 ? 2 : 0; ${assertion}`);
      writeFileSync(join(root, "tests/unrelated.test.ts"), 'import { it } from "vitest"; it("unrelated", () => { throw new Error("must not select unrelated suite"); });');
      const plan = createVerificationPlan([{ status: "M", path: "src/delivery/queue.ts" }], { root });
      const test = plan.checks.find((check: { name: string }) => check.name === "受影响测试");
      const result = spawnSync(test.command, test.args, { cwd: root, encoding: "utf8" });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(stripVTControlCharacters(result.stdout)).toMatch(/Test Files\s+4 passed/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it.each(["D\0src/example.ts\0", "A\0unknown-input.json\0"])("falls back conservatively for %s", output => {
    const plan = createVerificationPlan(parseChangedFiles(output));
    expect(plan.checks.some((check: { name: string }) => check.name === "完整测试")).toBe(true);
    expect(plan.reason).toContain("保守");
  });

  it("classifies specialized checks across additions, deletions, and renamed old/new paths", () => {
    expect(verificationScope(parseChangedFiles("D\0package-lock.json\0A\0renamed.json\0"))).toEqual({ package: true, appServer: true });
    expect(verificationScope([{ status: "M", path: "src/codex-client/client.ts" }])).toEqual({ package: false, appServer: true });
    expect(verificationScope([{ status: "M", path: "docs/codex-cli-upgrade.md" }])).toEqual({ package: false, appServer: false });
    expect(() => parseChangedFiles("M\0truncated")).toThrow();
    expect(() => parseChangedFiles("M\0")).toThrow();
    expect(() => parseChangedFiles("R100\0old\0new\0")).toThrow();
    const packagePlan = createVerificationPlan([{ status: "M", path: "package.json" }]);
    expect(packagePlan.checks.filter((check: { name: string }) => /安装冒烟/u.test(check.name))).toHaveLength(1);
    expect(packagePlan.checks.some((check: { name: string }) => check.name === "干净源码安装冒烟")).toBe(false);
    const protocolPlan = createVerificationPlan([{ status: "D", path: "src/codex-protocol/generated/Example.ts" }]);
    const contract = protocolPlan.checks.find((check: { name: string }) => check.name === "真实 App Server 合同");
    expect(contract.environment.RUN_CODEX_CONTRACT).toBe("1");
    expect(contract.args).toContain("tests/real-app-server-reset-credits.test.ts");
  });

  it.each([
    "package.json", "package-lock.json", "scripts/verification-scope.mjs", "scripts/verify-commit.mjs",
    "scripts/run-upgrade-validation.mjs", ".github/workflows/ci.yml", ".githooks/pre-commit",
    "runtime/executable.mjs", "scripts/service-install-management.mjs", "scripts/service-install-context.mjs",
    "scripts/local-installation.mjs",
  ])("checks installation and App Server boundaries when their gate or inputs change: %s", path => {
    expect(verificationScope([{ status: "M", path }])).toEqual({ package: true, appServer: true });
  });

  it.skipIf(process.platform === "win32")("captures partial staging and commit -a without leaking the commit index", () => {
    const root = mkdtempSync(join(tmpdir(), "commit-index-"));
    try {
      const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(git("init", "--quiet").status).toBe(0);
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "fixture");
      writeFileSync(join(root, "staged.md"), "initial\n");
      writeFileSync(join(root, "tracked.ts"), "initial\n");
      git("add", ".");
      expect(git("commit", "-m", "initial").status).toBe(0);
      mkdirSync(join(root, ".githooks"));
      copyFileSync(join(process.cwd(), ".githooks/pre-commit"), join(root, ".githooks/pre-commit"));
      git("config", "core.hooksPath", ".githooks");
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
const index = process.argv.indexOf("--changes-file");
const changes = fs.readFileSync(process.argv[index + 1], "utf8");
fs.writeFileSync(process.env.HOOK_RESULT, JSON.stringify({ changes, path: process.argv[index + 1], index: process.env.GIT_INDEX_FILE ?? null }));
`, { mode: 0o755 });
      const environment = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOOK_RESULT: join(root, "result") };
      writeFileSync(join(root, "staged.md"), "staged\n");
      git("add", "staged.md");
      writeFileSync(join(root, "staged.md"), "unstaged\n");
      writeFileSync(join(root, "tracked.ts"), "changed\n");
      const partial = spawnSync("git", ["commit", "-m", "partial"], { cwd: root, encoding: "utf8", env: environment });
      expect(partial.status, partial.stderr).toBe(0);
      const partiallyStaged = JSON.parse(readFileSync(environment.HOOK_RESULT, "utf8")) as { changes: string; path: string; index: unknown };
      expect(partiallyStaged.changes).toBe("M\0staged.md\0");
      expect(partiallyStaged.index).toBeNull();
      expect(existsSync(partiallyStaged.path)).toBe(false);
      const automatic = spawnSync("git", ["commit", "-am", "automatic"], { cwd: root, encoding: "utf8", env: environment });
      expect(automatic.status, automatic.stderr).toBe(0);
      const captured = JSON.parse(readFileSync(environment.HOOK_RESULT, "utf8")) as { changes: string; index: unknown };
      expect(parseChangedFiles(captured.changes)).toEqual([{ status: "M", path: "staged.md" }, { status: "M", path: "tracked.ts" }]);
      expect(captured.index).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
