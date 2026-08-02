import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error JavaScript upgrade helper intentionally has no declaration file.
import * as upgradeHelpers from "../scripts/prepare-codex-upgrade.mjs";
// @ts-expect-error JavaScript PR description helper intentionally has no declaration file.
import * as prDescriptionHelpers from "../scripts/check-upgrade-pr-description.mjs";

const {
  assertCleanWorktree,
  assertVersionTransition,
  parseCodexCliVersion,
  parseUpgradeArguments,
  upgradeReviewChecklist,
} = upgradeHelpers;
const { checkUpgradePullRequestDescription } = prDescriptionHelpers;

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

  it("keeps automated upgrade proposals draft-only with isolated write permissions", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/codex-upgrade-preview.yml"),
      "utf8",
    );
    const proposalStart = workflow.indexOf("\n  propose:");
    expect(proposalStart).toBeGreaterThan(0);

    const preview = workflow.slice(0, proposalStart);
    const proposal = workflow.slice(proposalStart);
    expect(workflow).toContain('cron: "17 3 * * *"');
    expect(preview).toContain("contents: read");
    expect(preview).not.toContain("contents: write");
    expect(preview).not.toContain("pull-requests: write");
    expect(proposal).toContain("contents: write");
    expect(proposal).toContain("pull-requests: write");
    expect(proposal).toContain("gh pr create");
    expect(proposal).toContain("--draft");
    expect(workflow).not.toContain("gh pr merge");
    expect(workflow).not.toContain("npm publish");
  });

  it("requires project benefits and tradeoffs before an upgrade PR is ready", () => {
    const draft = {
      pull_request: {
        draft: true,
        title: "升级 Codex CLI 至 0.147.0",
        body: "待 Codex 填写",
      },
    };
    expect(checkUpgradePullRequestDescription(draft)).toEqual({ checked: false });

    const ready = {
      pull_request: {
        draft: false,
        title: "升级 Codex CLI 至 0.147.0",
        body: [
          "## 对本项目的收益",
          "现有共享 App Server 路径获得明确的稳定性收益。",
          "## 本次采用",
          "适配现有业务使用的协议变化，并说明本地入口。",
          "## 本次不采用",
          "不导出没有当前需求的新 RPC，避免扩大支持边界。",
          "## 风险与验证",
          "覆盖定向测试、真实合同和完整提交门禁。",
        ].join("\n\n"),
      },
    };
    expect(checkUpgradePullRequestDescription(ready)).toEqual({ checked: true });
    expect(() => checkUpgradePullRequestDescription({
      ...ready,
      pull_request: {
        ...ready.pull_request,
        body: ready.pull_request.body.replace(
          "现有共享 App Server 路径获得明确的稳定性收益。",
          "待 Codex 填写",
        ),
      },
    })).toThrow("对本项目的收益");
    expect(() => checkUpgradePullRequestDescription({
      ...ready,
      pull_request: {
        ...ready.pull_request,
        body: ready.pull_request.body.replace(
          "不导出没有当前需求的新 RPC，避免扩大支持边界。",
          "无",
        ),
      },
    })).toThrow("本次不采用");
  });
});
