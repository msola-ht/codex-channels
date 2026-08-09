import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { packageDir } from "./package-path.mjs";

export function projectSkillsRoot(projectRoot = packageDir) {
  return join(projectRoot, ".codex", "skills");
}

export function agentsSkillsDirectory(environment = process.env) {
  const override = environment.CODEX_AGENTS_SKILLS_DIR?.trim();
  return override || join(homedir(), ".agents", "skills");
}

export function listProjectSkills({
  projectRoot = packageDir,
  environment = process.env,
} = {}) {
  const root = projectSkillsRoot(projectRoot);
  if (!existsSync(root)) return [];
  const installed = new Set(listInstalledSkills({ environment }));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
      && !entry.name.startsWith(".")
      && existsSync(join(root, entry.name, "SKILL.md"))
    )
    .map((entry) => ({
      name: entry.name,
      path: join(root, entry.name),
      installed: installed.has(entry.name),
    }));
}

export function listInstalledSkills({ environment = process.env } = {}) {
  const root = agentsSkillsDirectory(environment);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
      && !entry.name.startsWith(".")
      && existsSync(join(root, entry.name, "SKILL.md"))
    )
    .map((entry) => entry.name);
}

export function installSkill({
  name,
  projectRoot = packageDir,
  environment = process.env,
  overwrite = false,
} = {}) {
  validateSkillName(name);
  const source = join(projectSkillsRoot(projectRoot), name);
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`项目技能不存在：${name}`);
  }
  const targetRoot = agentsSkillsDirectory(environment);
  const target = join(targetRoot, name);
  if (existsSync(target)) {
    if (!overwrite) {
      return { name, installed: false, target, reason: "exists" };
    }
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(targetRoot, { recursive: true });
  cpSync(source, target, { recursive: true });
  return { name, installed: true, target };
}

export function uninstallSkill({ name, environment = process.env } = {}) {
  validateSkillName(name);
  const target = join(agentsSkillsDirectory(environment), name);
  if (!existsSync(target)) {
    return { name, removed: false, target };
  }
  rmSync(target, { recursive: true, force: true });
  return { name, removed: true, target };
}

export async function runSkillSetup({
  output = process.stdout,
  prompts = clackPrompts,
  projectRoot = packageDir,
  environment = process.env,
} = {}) {
  while (true) {
    const action = await prompts.select({
      message: "选择技能操作",
      showInstructions: false,
      options: [
        {
          value: "install",
          label: "安装或更新",
          hint: "从项目 .codex/skills 安装到 ~/.agents/skills",
        },
        {
          value: "uninstall",
          label: "卸载",
          hint: "从 ~/.agents/skills 删除技能",
        },
        { value: "back", label: "返回", hint: "返回设置类别" },
      ],
    });
    if (prompts.isCancel(action) || action === "back") {
      return { action: "back" };
    }
    if (action === "install") {
      const skills = listProjectSkills({ projectRoot, environment });
      if (skills.length === 0) {
        output.write("项目 .codex/skills 下没有可安装技能。\n");
        continue;
      }
      const skill = await prompts.select({
        message: "选择要安装的技能",
        showInstructions: false,
        options: [
          ...skills.map((entry) => ({
            value: entry.name,
            label: entry.name,
            hint: entry.installed ? "已安装，选择后确认覆盖" : "未安装",
          })),
          { value: "back", label: "返回", hint: "返回技能操作" },
        ],
      });
      if (prompts.isCancel(skill) || skill === "back") continue;
      let overwrite = false;
      if (listInstalledSkills({ environment }).includes(skill)) {
        const confirmed = await prompts.confirm({
          message: `${skill} 已安装，覆盖更新？`,
          initialValue: true,
        });
        if (prompts.isCancel(confirmed) || !confirmed) continue;
        overwrite = true;
      }
      const result = installSkill({
        name: skill,
        projectRoot,
        environment,
        overwrite,
      });
      output.write(result.installed
        ? `已安装技能 ${result.name}：${result.target}\n下个会话生效。\n`
        : `未安装（${result.reason}）：${result.name}\n`);
      continue;
    }
    if (action === "uninstall") {
      const installed = listInstalledSkills({ environment });
      if (installed.length === 0) {
        output.write("~/.agents/skills 下没有已安装技能。\n");
        continue;
      }
      const skill = await prompts.select({
        message: "选择要卸载的技能",
        showInstructions: false,
        options: [
          ...installed.map((name) => ({ value: name, label: name })),
          { value: "back", label: "返回", hint: "返回技能操作" },
        ],
      });
      if (prompts.isCancel(skill) || skill === "back") continue;
      const confirmed = await prompts.confirm({
        message: `确认卸载技能 ${skill}？`,
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || !confirmed) continue;
      const result = uninstallSkill({ name: skill, environment });
      output.write(result.removed
        ? `已卸载技能 ${result.name}。\n`
        : `技能不存在：${result.name}\n`);
      continue;
    }
    throw new Error(`未知技能操作：${String(action)}`);
  }
}

function validateSkillName(name) {
  if (
    typeof name !== "string"
    || name.length === 0
    || name.includes("/")
    || name.includes("\\")
    || name.includes("..")
  ) {
    throw new Error(`无效技能名称：${String(name)}`);
  }
}
