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

Codex 0.145.0 的 Plugin API 仍在开发中。

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

  it("validates an rc tag and publishes rc packages to the next channel", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codexc-release-rc-tag-"));
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
      const rcVersion = "0.146.0-rc.1";
      const rcSource = readme.replace(
        "`main` 开发基线：`0.146.0`（尚未发布）",
        `\`main\` 开发基线：\`${rcVersion}\`（尚未发布）`,
      );
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ version: rcVersion }),
      );
      writeFileSync(
        join(fixture, "README.md"),
        renderPublishedReadme(rcSource, rcVersion),
      );

      const result = spawnSync(
        process.execPath,
        [join(scriptsDirectory, "check-release-tag.mjs"), `v${rcVersion}`],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, GITHUB_REF_NAME: "" },
        },
      );
      const workflow = readFileSync(resolve(".github/workflows/publish.yml"), "utf8");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`发布版本匹配：v${rcVersion}`);
      expect(workflow).toContain("contains(github.ref_name, '-rc.') && 'next'");
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
      expect(result.stderr).toContain("README 尚未同步为发布版本 0.146.0");
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
    expect(updated).toContain("Codex 0.146.0 的 Plugin API");
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

  it("publishes an rc version without replacing the current stable installation", () => {
    const rcReadme = renderPublishedReadme(
      readme.replace(
        "`main` 开发基线：`0.146.0`（尚未发布）",
        "`main` 开发基线：`0.146.0-rc.1`（尚未发布）",
      ),
      "0.146.0-rc.1",
    );

    expect(rcReadme).toContain("`main` 开发基线：`0.146.0-rc.1`");
    expect(rcReadme).toContain("当前正式版：`0.145.0`");
    expect(rcReadme).toContain("当前预发行版：`0.146.0-rc.1`");
    expect(rcReadme).toContain("`codex-cli 0.145.0`");
    expect(rcReadme).toContain("预发行版要求：macOS 或 Linux、Node.js 22.13+");
    expect(rcReadme).toContain("`codex-cli 0.146.0`");
    expect(rcReadme).toContain("@openai/codex@0.146.0");
    expect(rcReadme).toContain("@hegenai/codexc@0.146.0-rc.1");
    expect(renderPublishedReadme(rcReadme, "0.146.0-rc.1")).toBe(rcReadme);

    const rc2Readme = renderPublishedReadme(rcReadme, "0.146.0-rc.2");
    expect(rc2Readme).toContain("当前预发行版：`0.146.0-rc.2`");
    expect(rc2Readme).toContain("@hegenai/codexc@0.146.0-rc.2");
    expect(rc2Readme).not.toContain("0.146.0-rc.1");
    expect(() => renderPublishedReadme(rc2Readme, "0.146.0-rc.1")).toThrow("降级");
  });

  it("removes the rc installation when the same base version becomes stable", () => {
    const rcReadme = renderPublishedReadme(
      readme.replace(
        "`main` 开发基线：`0.146.0`（尚未发布）",
        "`main` 开发基线：`0.146.0-rc.1`（尚未发布）",
      ),
      "0.146.0-rc.1",
    );
    const stableReadme = renderPublishedReadme(
      rcReadme.replace(
        "`main` 开发基线：`0.146.0-rc.1`",
        "`main` 开发基线：`0.146.0`（尚未发布）",
      ),
      "0.146.0",
    );

    expect(stableReadme).toContain("当前正式版：`0.146.0`");
    expect(stableReadme).not.toContain("当前预发行版");
    expect(stableReadme).not.toContain("测试下一正式版预发行包");
    expect(stableReadme).not.toContain("0.146.0-rc.1");
  });

  it("keeps an older fix preview intact when an rc becomes stable", () => {
    const fixReadme = renderPublishedReadme(readme, "0.145.0-fix2");
    const rcReadme = renderPublishedReadme(fixReadme, "0.146.0-rc.1");
    const stableReadme = renderPublishedReadme(
      rcReadme.replace(
        "`main` 开发基线：`0.146.0-rc.1`",
        "`main` 开发基线：`0.146.0`（尚未发布）",
      ),
      "0.146.0",
    );

    expect(stableReadme).toContain("当前修复预览版：`0.145.0-fix2`");
    expect(stableReadme).toContain("@hegenai/codexc@0.145.0-fix2");
    expect(stableReadme).not.toContain("@hegenai/codexc@0.146.0-fix2");
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
      "正式版本、rc 预发行版或 fix 修复版",
    );
    expect(() =>
      renderPublishedReadme("# Codex Connect Gateway\n", "0.146.0")
    ).toThrow("受控");
  });
});
