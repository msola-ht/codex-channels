import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript release helper intentionally has no declaration file.
import * as releaseHelpers from "../scripts/resolve-codex-release.mjs";
// @ts-expect-error JavaScript GitHub release helper intentionally has no declaration file.
import * as releaseApiHelpers from "../scripts/codex-release-api.mjs";
// @ts-expect-error JavaScript report helper intentionally has no declaration file.
import * as reportHelpers from "../scripts/write-upgrade-report.mjs";
// @ts-expect-error JavaScript protocol analyzer intentionally has no declaration file.
import * as protocolAnalysisHelpers from "../scripts/analyze-upgrade-protocol.mjs";
// @ts-expect-error JavaScript public CLI contract helper intentionally has no declaration file.
import * as publicCliContractHelpers from "../scripts/codex-public-cli-contract.mjs";
// @ts-expect-error JavaScript validation helper intentionally has no declaration file.
import * as validationHelpers from "../scripts/run-upgrade-validation.mjs";

const { compareStableVersions, validateOfficialRelease } = releaseHelpers;
const { fetchCodexReleaseJson } = releaseApiHelpers;
const {
  collectGitDiff,
  renderUpgradeSummary,
} = reportHelpers;
const { analyzeProtocolDiff } = protocolAnalysisHelpers;
const {
  comparePublicCliContracts,
  parsePublicCliContract,
  renderPublicCliContractImpact,
  validateCodexUserSettingsAgainstContract,
} = publicCliContractHelpers;
const { defaultUpgradeValidationStages, runUpgradeValidationStages } = validationHelpers;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex release upgrade preview", () => {
  it("keeps release-only README synchronization outside the document-free preview", () => {
    const unitTests = defaultUpgradeValidationStages.find(
      (stage: { id: string }) => stage.id === "unit-tests",
    );

    expect(unitTests).toMatchObject({
      name: "测试（不含发布前 README 同步）",
      args: [
        "test",
        "--",
        "--exclude",
        "tests/release-readme-sync.test.ts",
      ],
    });
  });

  it("accepts only the requested official stable release", () => {
    expect(validateOfficialRelease({
      tag_name: "rust-v0.146.0",
      draft: false,
      prerelease: false,
      html_url: "https://github.com/openai/codex/releases/tag/rust-v0.146.0",
    }, "0.146.0")).toEqual({
      version: "0.146.0",
      tag: "rust-v0.146.0",
      url: "https://github.com/openai/codex/releases/tag/rust-v0.146.0",
    });
  });

  it("rejects prereleases, drafts and mismatched tags", () => {
    expect(() => validateOfficialRelease({
      tag_name: "rust-v0.146.0-alpha.1",
      draft: false,
      prerelease: true,
    }, undefined)).toThrow("正式发行版");
    expect(() => validateOfficialRelease({
      tag_name: "rust-v0.146.0",
      draft: true,
      prerelease: false,
    }, "0.146.0")).toThrow("正式发行版");
    expect(() => validateOfficialRelease({
      tag_name: "rust-v0.147.0",
      draft: false,
      prerelease: false,
    }, "0.146.0")).toThrow("版本不匹配");
  });

  it("orders stable releases without accepting lexical version mistakes", () => {
    expect(compareStableVersions("0.146.0", "0.145.0")).toBeGreaterThan(0);
    expect(compareStableVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareStableVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("retries transient GitHub failures but fails closed on other client errors", async () => {
    let attempts = 0;
    const result = await fetchCodexReleaseJson("https://api.github.test/releases", {
      fetchImplementation: async () => {
        attempts += 1;
        if (attempts < 3) {
          return { ok: false, status: 504 };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ tag_name: "rust-v0.146.0" }),
        };
      },
      sleep: async () => undefined,
    });
    expect(attempts).toBe(3);
    expect(result).toEqual({ tag_name: "rust-v0.146.0" });

    attempts = 0;
    await expect(fetchCodexReleaseJson("https://api.github.test/releases", {
      fetchImplementation: async () => {
        attempts += 1;
        return { ok: false, status: 404 };
      },
      sleep: async () => undefined,
    })).rejects.toThrow("HTTP 404");
    expect(attempts).toBe(1);
  });

  it("retries when the GitHub response body is terminated", async () => {
    let attempts = 0;
    const result = await fetchCodexReleaseJson("https://api.github.test/releases", {
      fetchImplementation: async () => {
        attempts += 1;
        return {
          ok: true,
          status: 200,
          json: async () => {
            if (attempts < 3) {
              throw new TypeError("terminated");
            }
            return [{ tag_name: "rust-v0.146.0" }];
          },
        };
      },
      sleep: async () => undefined,
    });

    expect(attempts).toBe(3);
    expect(result).toEqual([{ tag_name: "rust-v0.146.0" }]);
  });

  it("renders a file list and protocol file count for the CI summary", () => {
    const summary = renderUpgradeSummary(
      "0.146.0",
      "0123456789abcdef",
      [
        "M\tpackage.json",
        "M\tsrc/codex-protocol/version.json",
        "A\tsrc/codex-protocol/generated/v2/NewType.ts",
      ].join("\n"),
      "3 files changed, 10 insertions(+), 2 deletions(-)",
    );
    expect(summary).toContain("变更文件：3");
    expect(summary).toContain("协议目录文件：2");
    expect(summary).toContain("基线提交：0123456789abcdef");
    expect(summary).toContain("NewType.ts");
  });

  it("renders a failed stable report even when generation produced no diff", () => {
    const summary = renderUpgradeSummary(
      "0.146.0",
      "0123456789abcdef",
      "",
      "",
      "stable",
      "failure",
    );
    expect(summary).toContain("正式升级提案");
    expect(summary).toContain("自动验证：失败");
    expect(summary).toContain("变更文件：0");
    expect(summary).toContain("(没有文件差异)");
  });

  it("renders every independent validation stage in the summary", () => {
    const summary = renderUpgradeSummary(
      "0.146.0",
      "0123456789abcdef",
      "",
      "",
      "stable",
      "failure",
      {
        stages: [
          {
            name: "TypeScript 与版本",
            status: "failed",
            log: "logs/typecheck.log",
          },
          {
            name: "全量测试",
            status: "passed",
            log: "logs/unit-tests.log",
          },
        ],
      },
    );
    expect(summary).toContain("| TypeScript 与版本 | 失败 |");
    expect(summary).toContain("| 全量测试 | 通过 |");
  });

  it("writes a failure report when the target release could not be resolved", () => {
    const output = mkdtempSync(join(tmpdir(), "codexc-unresolved-report-"));
    temporaryDirectories.push(output);
    const script = join(process.cwd(), "scripts/write-upgrade-report.mjs");
    const failure = spawnSync(
      process.execPath,
      [script, "unresolved", output, "stable", "failure"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          RESOLUTION_OUTCOME: "failure",
        },
      },
    );

    expect(failure.status).toBe(0);
    expect(readFileSync(join(output, "target-version.txt"), "utf8"))
      .toBe("unresolved\n");
    expect(readFileSync(join(output, "summary.md"), "utf8"))
      .toContain("目标版本尚未解析");
    expect(readFileSync(join(output, "public-cli-impact.md"), "utf8"))
      .toContain("Codex 公开 CLI 合同影响");
    expect(JSON.parse(
      readFileSync(join(output, "results.json"), "utf8"),
    )).toMatchObject({
      result: "failure",
      stages: [{
        id: "resolution",
        status: "failed",
        log: "logs/resolve.log",
      }],
    });

    const invalidSuccess = spawnSync(
      process.execPath,
      [script, "unresolved", output, "stable", "success"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(invalidSuccess.status).not.toBe(0);
  });

  it("continues validation after a failed stage and writes structured results", async () => {
    const output = mkdtempSync(join(tmpdir(), "codexc-upgrade-validation-"));
    temporaryDirectories.push(output);
    const result = await runUpgradeValidationStages([
      {
        id: "failure",
        name: "预期失败",
        command: process.execPath,
        args: ["-e", "process.exit(2)"],
      },
      {
        id: "success",
        name: "后续成功",
        command: process.execPath,
        args: ["-e", "console.log('continued')"],
      },
    ], output);

    expect(result.result).toBe("failure");
    expect(result.stages.map((stage: { status: string }) => stage.status))
      .toEqual(["failed", "passed"]);
    expect(readFileSync(join(output, "logs/success.log"), "utf8"))
      .toContain("continued");
    expect(JSON.parse(
      readFileSync(join(output, "validation-results.json"), "utf8"),
    )).toMatchObject({ result: "failure" });
  });

  it("reports RPC and required-field protocol changes against HEAD", () => {
    const repository = mkdtempSync(join(tmpdir(), "codexc-protocol-impact-"));
    temporaryDirectories.push(repository);
    git(repository, ["init", "--quiet"]);
    git(repository, ["config", "user.name", "Codex Test"]);
    git(repository, ["config", "user.email", "codex@example.invalid"]);
    const generated = join(repository, "src/codex-protocol/generated/v2");
    mkdirSync(generated, { recursive: true });
    writeFileSync(
      join(generated, "Thread.ts"),
      "export type Thread = { id: string, ephemeral: boolean, };\n",
    );
    const requestPath = join(
      repository,
      "src/codex-protocol/generated/ClientRequest.ts",
    );
    writeFileSync(
      requestPath,
      "export type ClientRequest = { \"method\": \"thread/list\" };\n",
    );
    git(repository, ["add", "."]);
    git(repository, ["commit", "--quiet", "-m", "initial"]);

    writeFileSync(
      join(generated, "Thread.ts"),
      "export type Thread = { id: string, ephemeral: boolean, isPinned: boolean, };\n",
    );
    writeFileSync(
      requestPath,
      "export type ClientRequest = { \"method\": \"thread/list\" }"
        + " | { \"method\": \"thread/pin\" };\n",
    );
    const changed = [
      "M\tsrc/codex-protocol/generated/v2/Thread.ts",
      "M\tsrc/codex-protocol/generated/ClientRequest.ts",
    ].join("\n");
    const impact = analyzeProtocolDiff(repository, changed);

    expect(impact).toContain("新增：`thread/pin`");
    expect(impact).toContain("新增必填");
    expect(impact).toContain("`Thread.isPinned`");
  });

  it("extracts the project-used public CLI option contract from help", () => {
    const contract = parsePublicCliContract("codex-cli 0.150.1\n", [
      "Codex CLI",
      "",
      "Options:",
      "      --remote <ADDR>",
      "          Connect to a remote app server endpoint.",
      "  -s, --sandbox <SANDBOX_MODE>",
      "          [possible values: read-only, workspace-write, danger-full-access]",
      "  -a, --ask-for-approval <APPROVAL_POLICY>",
      "          Possible values:",
      "          - on-request: Ask when needed",
      "          - never: Never ask",
      "  -C, --cd <DIR>",
      "  -p, --profile <CONFIG_PROFILE_V2>",
    ].join("\n"));

    expect(contract).toMatchObject({
      schemaVersion: 1,
      codexCli: "0.150.1",
      options: {
        "--ask-for-approval": {
          present: true,
          aliases: ["-a"],
          argument: "<APPROVAL_POLICY>",
          values: ["on-request", "never"],
        },
        "--sandbox": {
          present: true,
          values: ["read-only", "workspace-write", "danger-full-access"],
        },
      },
    });
  });

  it("separates added, removed and changed public CLI contract entries", () => {
    const before = {
      schemaVersion: 1,
      codexCli: "0.150.1",
      options: {
        "--ask-for-approval": {
          present: true,
          aliases: ["-a"],
          argument: "<APPROVAL_POLICY>",
          values: ["on-request", "never"],
        },
        "--sandbox": {
          present: true,
          aliases: ["-s"],
          argument: "<SANDBOX_MODE>",
          values: ["read-only", "workspace-write", "danger-full-access"],
        },
      },
    };
    const after = {
      schemaVersion: 1,
      codexCli: "0.151.0",
      options: {
        "--ask-for-approval": {
          present: true,
          aliases: ["-a"],
          argument: "<APPROVAL_POLICY>",
          values: ["on-request", "never", "always"],
        },
        "--sandbox": {
          present: true,
          aliases: [],
          argument: "<MODE>",
          values: ["read-only", "workspace-write"],
        },
      },
    };

    const changes = comparePublicCliContracts(before, after);
    expect(changes).toEqual([
      {
        option: "--ask-for-approval",
        kind: "values",
        added: ["always"],
        removed: [],
      },
      {
        option: "--sandbox",
        kind: "signature",
        before: "-s, --sandbox <SANDBOX_MODE>",
        after: "--sandbox <MODE>",
      },
      {
        option: "--sandbox",
        kind: "values",
        added: [],
        removed: ["danger-full-access"],
      },
    ]);
    const report = renderPublicCliContractImpact(before, after);
    expect(report).toContain("新增值：`always`");
    expect(report).toContain("删除值：`danger-full-access`");
    expect(report).toContain("参数签名变化");
  });

  it("rejects user settings that the locked public CLI contract no longer accepts", () => {
    const contract = {
      schemaVersion: 1,
      codexCli: "0.150.1",
      options: {
        "--ask-for-approval": {
          present: true,
          aliases: ["-a"],
          argument: "<APPROVAL_POLICY>",
          values: ["on-request", "never"],
        },
      },
    };

    expect(() => validateCodexUserSettingsAgainstContract(
      { approval_policy: "on-request" },
      contract,
    )).not.toThrow();
    expect(() => validateCodexUserSettingsAgainstContract(
      { approval_policy: "untrusted" },
      contract,
    )).toThrow("approval_policy = \"untrusted\"");
  });

  it("captures tracked and new files without changing the repository index", () => {
    const repository = mkdtempSync(join(tmpdir(), "codexc-upgrade-report-"));
    temporaryDirectories.push(repository);
    git(repository, ["init", "--quiet"]);
    git(repository, ["config", "user.name", "Codex Test"]);
    git(repository, ["config", "user.email", "codex@example.invalid"]);
    writeFileSync(join(repository, "tracked.txt"), "before\n");
    git(repository, ["add", "tracked.txt"]);
    git(repository, ["commit", "--quiet", "-m", "initial"]);

    writeFileSync(join(repository, "tracked.txt"), "after\n");
    writeFileSync(join(repository, "new.txt"), `${"x".repeat(1_100_000)}\n`);
    const diff = collectGitDiff(repository);

    expect(diff.nameStatus).toContain("M\ttracked.txt");
    expect(diff.nameStatus).toContain("A\tnew.txt");
    expect(diff.patch).toContain("diff --git a/new.txt b/new.txt");
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("");
  });
});

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
}
