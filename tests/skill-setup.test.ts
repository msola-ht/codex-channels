import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installSkill,
  listInstalledSkills,
  listProjectSkills,
  runSkillSetup,
  uninstallSkill,
} from "../scripts/skill-setup.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-setup-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "project");
  const skillRoot = join(projectRoot, ".codex", "skills");
  const targetRoot = join(root, "agents-skills");
  mkdirSync(join(skillRoot, "channel-image", "agents"), { recursive: true });
  writeFileSync(
    join(skillRoot, "channel-image", "SKILL.md"),
    "---\nname: channel-image\ndescription: 发送图片到渠道\n---\n\n# 渠道图片发送\n",
  );
  writeFileSync(
    join(skillRoot, "channel-image", "agents", "openai.yaml"),
    "interface:\n  display_name: 渠道图片发送\n",
  );
  mkdirSync(join(skillRoot, "not-a-skill"));
  const environment = {
    ...process.env,
    CODEX_AGENTS_SKILLS_DIR: targetRoot,
  };
  return { root, projectRoot, skillRoot, targetRoot, environment };
}

describe("skill setup", () => {
  it("lists project skills that have SKILL.md and marks installed ones", () => {
    const fixtureData = fixture();

    const skills = listProjectSkills({
      projectRoot: fixtureData.projectRoot,
      environment: fixtureData.environment,
    });

    expect(skills.map((skill) => skill.name)).toEqual(["channel-image"]);
    expect(skills[0]!.installed).toBe(false);
  });

  it("installs a skill with its bundled metadata and rejects invalid names", () => {
    const fixtureData = fixture();

    const result = installSkill({
      name: "channel-image",
      projectRoot: fixtureData.projectRoot,
      environment: fixtureData.environment,
    });

    expect(result).toMatchObject({ installed: true });
    expect(
      readFileSync(join(result.target, "SKILL.md"), "utf8"),
    ).toContain("name: channel-image");
    expect(existsSync(join(result.target, "agents", "openai.yaml"))).toBe(true);
    expect(listInstalledSkills({ environment: fixtureData.environment }))
      .toEqual(["channel-image"]);

    expect(() => installSkill({
      name: "../escape",
      projectRoot: fixtureData.projectRoot,
      environment: fixtureData.environment,
    })).toThrow("无效技能名称");
  });

  it("keeps an existing installation unless overwrite is confirmed", () => {
    const fixtureData = fixture();
    installSkill({
      name: "channel-image",
      projectRoot: fixtureData.projectRoot,
      environment: fixtureData.environment,
    });

    const skipped = installSkill({
      name: "channel-image",
      projectRoot: fixtureData.projectRoot,
      environment: fixtureData.environment,
    });
    expect(skipped).toMatchObject({ installed: false, reason: "exists" });

    writeFileSync(
      join(fixtureData.skillRoot, "channel-image", "SKILL.md"),
      "---\nname: channel-image\ndescription: 更新后的描述\n---\n",
    );
    const replaced = installSkill({
      name: "channel-image",
      projectRoot: fixtureData.projectRoot,
      environment: fixtureData.environment,
      overwrite: true,
    });
    expect(replaced).toMatchObject({ installed: true });
    expect(
      readFileSync(join(replaced.target, "SKILL.md"), "utf8"),
    ).toContain("更新后的描述");
  });

  it("uninstalls an installed skill", () => {
    const fixtureData = fixture();
    installSkill({
      name: "channel-image",
      projectRoot: fixtureData.projectRoot,
      environment: fixtureData.environment,
    });

    const removed = uninstallSkill({
      name: "channel-image",
      environment: fixtureData.environment,
    });
    expect(removed).toMatchObject({ removed: true });
    expect(existsSync(removed.target)).toBe(false);
    expect(uninstallSkill({
      name: "channel-image",
      environment: fixtureData.environment,
    })).toMatchObject({ removed: false });
  });

  it("returns back from the skill setup menu", async () => {
    const prompts = {
      select: async () => "back",
      isCancel: () => false,
      confirm: async () => true,
    };

    const result = await runSkillSetup({
      output: { write: () => undefined },
      prompts,
    });

    expect(result).toEqual({ action: "back" });
  });
});
