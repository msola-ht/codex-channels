import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/webui-i18n.mjs");
const directories: string[] = [];
function fixture(source: string) {
  const cwd = mkdtempSync(join(tmpdir(), "webui-i18n-"));
  directories.push(cwd);
  mkdirSync(join(cwd, "webui/src/lib/i18n"), { recursive: true });
  writeFileSync(join(cwd, "webui/src/lib/i18n/messages.ts"), source);
  writeFileSync(join(cwd, "webui/i18n-glossary.json"), JSON.stringify({
    sourceLanguage: "zh-CN", targetLanguage: "en-US", terms: [], preserve: [], rules: [],
  }));
  return cwd;
}
function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
afterEach(() => { for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true }); });

describe("WebUI translation preparation", () => {
  it("checks missing keys and placeholder changes", () => {
    const cwd = fixture('const zh = { hello: "你好 {name}" }; const en = { hello: "Hello {person}", extra: "Extra" };');
    const result = run(cwd, "--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("placeholder_mismatch");
    expect(result.stderr).toContain("missing_source");
    writeFileSync(join(cwd, "webui/src/lib/i18n/messages.ts"), 'const zh = { hello: "你好" }; const en = {};');
    expect(run(cwd, "--check").stderr).toContain("missing_translation");
  });

  it("extracts literals without executing the dictionary and rejects computed values", () => {
    const cwd = fixture('throw new Error("must-not-execute"); const zh = { hello: "你好" }; const en = { hello: "Hello" };');
    expect(run(cwd, "--check").status).toBe(0);
    writeFileSync(join(cwd, "webui/src/lib/i18n/messages.ts"), 'const zh = { hello: process.exit(42) }; const en = { hello: "Hello" };');
    const result = run(cwd, "--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("字面量");
  });

  it("reports changed source even when an English value already exists", () => {
    const cwd = fixture('const zh = { changed: "旧文案", removed: "删除" }; const en = { changed: "Existing", removed: "Remove" };');
    git(cwd, "init", "-q");
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", `core.hooksPath=${join(cwd, "fixture-hooks")}`, "commit", "-qm", "baseline");
    writeFileSync(join(cwd, "webui/src/lib/i18n/messages.ts"), 'const zh = { changed: "新文案", added: "新增" }; const en = { changed: "Existing" };');
    const result = run(cwd, "--base", "HEAD");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { entries: Array<Record<string, unknown>> };
    expect(report.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "changed", status: "source_changed", translation: "Existing", needsReview: true }),
      expect.objectContaining({ key: "added", status: "new", needsTranslation: true }),
      expect.objectContaining({ key: "removed", status: "removed", needsReview: false }),
    ]));
    expect(run(cwd, "--base", "missing-reference").status).toBe(1);
  });

  it("treats a baseline without a dictionary as the first introduction", () => {
    const cwd = fixture('const zh = { hello: "你好" }; const en = { hello: "Hello" };');
    git(cwd, "init", "-q");
    git(cwd, "add", "webui/i18n-glossary.json");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", `core.hooksPath=${join(cwd, "fixture-hooks")}`, "commit", "-qm", "baseline");
    const report = JSON.parse(run(cwd, "--base", "HEAD").stdout) as { entries: unknown[] };
    expect(report.entries).toEqual([
      expect.objectContaining({ key: "hello", status: "new", needsReview: true }),
    ]);
  });
});
