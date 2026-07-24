import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
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
// @ts-expect-error JavaScript Alpha release helper intentionally has no declaration file.
import * as alphaReleaseHelpers from "../scripts/resolve-codex-alpha.mjs";
// @ts-expect-error JavaScript report helper intentionally has no declaration file.
import * as reportHelpers from "../scripts/write-upgrade-report.mjs";

const { compareStableVersions, validateOfficialRelease } = releaseHelpers;
const { fetchCodexReleaseJson } = releaseApiHelpers;
const {
  compareAlphaVersions,
  selectLatestOfficialAlpha,
  validateOfficialAlphaRelease,
} = alphaReleaseHelpers;
const { collectGitDiff, renderUpgradeSummary } = reportHelpers;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex release upgrade preview", () => {
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

  it("selects the highest official Alpha and rejects stable releases", () => {
    const alpha = (version: string) => ({
      tag_name: `rust-v${version}`,
      draft: false,
      prerelease: true,
      html_url: `https://github.com/openai/codex/releases/tag/rust-v${version}`,
    });
    expect(selectLatestOfficialAlpha([
      alpha("0.146.0-alpha.5"),
      alpha("0.146.0-alpha.3.1"),
      alpha("0.146.0-alpha.6"),
      {
        tag_name: "rust-v0.145.0",
        draft: false,
        prerelease: false,
      },
    ])).toEqual({
      version: "0.146.0-alpha.6",
      tag: "rust-v0.146.0-alpha.6",
      url: "https://github.com/openai/codex/releases/tag/rust-v0.146.0-alpha.6",
    });
    expect(compareAlphaVersions(
      "0.146.0-alpha.4",
      "0.146.0-alpha.3.1",
    )).toBeGreaterThan(0);
    expect(() => validateOfficialAlphaRelease({
      tag_name: "rust-v0.146.0",
      draft: false,
      prerelease: false,
    })).toThrow("Alpha Release");
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

  it("renders a failed Alpha report even when generation produced no diff", () => {
    const summary = renderUpgradeSummary(
      "0.146.0-alpha.6",
      "0123456789abcdef",
      "",
      "",
      "alpha",
      "failure",
    );
    expect(summary).toContain("Alpha Canary");
    expect(summary).toContain("自动验证：失败");
    expect(summary).toContain("变更文件：0");
    expect(summary).toContain("(没有文件差异)");
    expect(summary).toContain("不可作为 main");
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
    writeFileSync(join(repository, "new.txt"), "new\n");
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
