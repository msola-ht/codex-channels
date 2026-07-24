import { describe, expect, it } from "vitest";

// @ts-expect-error JavaScript upgrade helper intentionally has no declaration file.
import * as upgradeHelpers from "../scripts/prepare-codex-upgrade.mjs";

const {
  assertCleanWorktree,
  assertVersionTransition,
  parseCodexCliVersion,
  parseUpgradeArguments,
  upgradeReviewChecklist,
} = upgradeHelpers;

describe("Codex CLI upgrade preparation", () => {
  it("accepts one exact target version and optional dry-run", () => {
    expect(parseUpgradeArguments(["0.146.0"])).toEqual({
      help: false,
      dryRun: false,
      targetVersion: "0.146.0",
    });
    expect(() => parseUpgradeArguments(["0.146.0-beta.1", "--dry-run"])).toThrow(
      "正式发行版本",
    );
    expect(parseUpgradeArguments(["--help"])).toEqual({
      help: true,
      dryRun: false,
    });
    expect(() => parseUpgradeArguments(["latest"])).toThrow("正式发行版本");
  });

  it("requires the canonical Codex CLI version output", () => {
    expect(parseCodexCliVersion("codex-cli 0.146.0\n")).toBe("0.146.0");
    expect(() => parseCodexCliVersion("codex 0.146.0")).toThrow("无法解析");
  });

  it("fails before generation when the worktree is dirty or the version is unchanged", () => {
    expect(() => assertCleanWorktree(" M README.md\n")).toThrow("工作区必须干净");
    expect(() => assertCleanWorktree("")).not.toThrow();
    expect(() => assertVersionTransition("0.145.0", "0.145.0")).toThrow("无需再次");
    expect(() => assertVersionTransition("0.145.0", "0.146.0")).not.toThrow();
    expect(() => assertVersionTransition("0.145.0", "0.144.0")).toThrow("拒绝降级");
  });

  it("hands generated changes to Codex for review instead of the operator", () => {
    expect(upgradeReviewChecklist("0.146.0").join("\n")).toContain(
      "请让 Codex 按 docs/codex-cli-upgrade.md 审查",
    );
  });
});
