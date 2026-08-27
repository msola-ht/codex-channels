import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error JavaScript release helper intentionally has no declaration file.
import * as releaseReadmeHelpers from "../scripts/sync-published-readme.mjs";

const { renderPublishedReadme } = releaseReadmeHelpers;

const readme = `# Codex Connect Gateway

\`main\` 开发基线：\`0.146.0\`（尚未发布）
当前正式版：\`0.145.0\`
要求：已登录的 \`codex-cli 0.145.0\`

\`\`\`bash
npm install -g @openai/codex@0.145.0
npm install -g @hegenai/codexc@0.145.0
\`\`\`

- 重新安装精确版本 \`@openai/codex@0.145.0\`。
`;

describe("published README synchronization", () => {
  it("keeps the repository README development baseline aligned with the package", () => {
    const repositoryReadme = readFileSync(resolve("README.md"), "utf8");
    const packageMetadata = JSON.parse(
      readFileSync(resolve("package.json"), "utf8"),
    ) as { version: string };

    expect(repositoryReadme).toContain(
      `\`main\` 开发基线：\`${packageMetadata.version}\``,
    );
  });

  it("validates a release tag without installed dependencies", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codexc-release-tag-"));
    const scriptsDirectory = join(fixture, "scripts");
    mkdirSync(scriptsDirectory);
    try {
      for (const name of [
        "check-release-tag.mjs",
        "package-path.mjs",
        "sync-published-readme.mjs",
      ]) {
        copyFileSync(resolve("scripts", name), join(scriptsDirectory, name));
      }
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ version: "0.146.0" }),
      );
      writeFileSync(
        join(fixture, "README.md"),
        renderPublishedReadme(readme, "0.146.0"),
      );

      const result = spawnSync(
        process.execPath,
        [join(scriptsDirectory, "check-release-tag.mjs"), "v0.146.0"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, GITHUB_REF_NAME: "" },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("发布版本匹配：v0.146.0");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a release tag before the repository README is finalized", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codexc-release-readme-stale-"));
    const scriptsDirectory = join(fixture, "scripts");
    mkdirSync(scriptsDirectory);
    try {
      for (const name of [
        "check-release-tag.mjs",
        "package-path.mjs",
        "sync-published-readme.mjs",
      ]) {
        copyFileSync(resolve("scripts", name), join(scriptsDirectory, name));
      }
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ version: "0.146.0" }),
      );
      writeFileSync(join(fixture, "README.md"), readme);

      const result = spawnSync(
        process.execPath,
        [join(scriptsDirectory, "check-release-tag.mjs"), "v0.146.0"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, GITHUB_REF_NAME: "" },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README 尚未同步为正式版本 0.146.0");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("updates only the published version and remains idempotent", () => {
    const updated = renderPublishedReadme(readme, "0.146.0");

    expect(updated).toContain("`main` 开发基线：`0.146.0`");
    expect(updated).not.toContain("`0.146.0`（尚未发布）");
    expect(updated).toContain("当前正式版：`0.146.0`");
    expect(updated).toContain("`codex-cli 0.146.0`");
    expect(updated).toContain("@openai/codex@0.146.0");
    expect(updated).toContain("@hegenai/codexc@0.146.0");
    expect(updated).not.toContain("0.145.0");
    expect(renderPublishedReadme(updated, "0.146.0")).toBe(updated);
  });

  it("publishes a Gateway fix version without changing the Codex CLI version", () => {
    const publishedReadme = renderPublishedReadme(readme, "0.146.0");
    const fixReadme = renderPublishedReadme(
      publishedReadme.replace(
        "`main` 开发基线：`0.146.0`",
        "`main` 开发基线：`0.146.0-fix1`",
      ),
      "0.146.0-fix1",
    );

    expect(fixReadme).toContain("`main` 开发基线：`0.146.0-fix1`");
    expect(fixReadme).toContain("当前正式版：`0.146.0`");
    expect(fixReadme).toContain("当前修复预览版：`0.146.0-fix1`");
    expect(fixReadme).toContain("`codex-cli 0.146.0`");
    expect(fixReadme).toContain("@openai/codex@0.146.0");
    expect(fixReadme).toContain("@hegenai/codexc@0.146.0-fix1");
    expect(renderPublishedReadme(fixReadme, "0.146.0-fix1")).toBe(fixReadme);
  });

  it("keeps a newer main baseline marked as unpublished", () => {
    const nextBaseline = readme.replace(
      "`main` 开发基线：`0.146.0`",
      "`main` 开发基线：`0.147.0`",
    );

    expect(renderPublishedReadme(nextBaseline, "0.146.0")).toContain(
      "`main` 开发基线：`0.147.0`（尚未发布）",
    );
  });

  it("fails closed for downgrade, unsupported prerelease, or an uncontrolled README", () => {
    expect(() => renderPublishedReadme(readme, "0.144.0")).toThrow("降级");
    expect(() => renderPublishedReadme(readme, "0.147.0")).toThrow("开发基线");
    expect(() => renderPublishedReadme(readme, "0.146.0-alpha.1")).toThrow(
      "正式版本或 fix 修复版",
    );
    expect(() =>
      renderPublishedReadme("# Codex Connect Gateway\n", "0.146.0")
    ).toThrow("受控");
  });
});
