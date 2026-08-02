import { isAbsolute } from "node:path";

import type { SkillsListResponse } from "../codex-protocol/index.js";
import type {
  InstalledSkill,
  InvocableSkill,
} from "../application/index.js";

export function toInstalledSkills(
  response: SkillsListResponse,
  cwd: string,
): InstalledSkill[] {
  return toDirectlyInstalledSkills(response, cwd).map(({ name, description }) => ({
    name,
    description,
  }));
}

export function resolveInvocableSkill(
  response: SkillsListResponse,
  cwd: string,
  name: string,
): InvocableSkill | undefined {
  const matches = toDirectlyInstalledSkills(response, cwd).filter(
    (skill) => skill.name === name,
  );
  if (matches.length > 1) {
    throw new Error("Codex 返回了重复的已启用 Skill 名称");
  }
  const skill = matches[0];
  if (
    skill
    && (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.name)
      || skill.name.length > 64
      || !isAbsolute(skill.path)
      || !skill.path.replaceAll("\\", "/").endsWith("/SKILL.md")
    )
  ) {
    throw new Error("Codex 返回了无法安全调用的 Skill");
  }
  return skill
    ? { name: skill.name, path: skill.path }
    : undefined;
}

interface DirectlyInstalledSkill extends InstalledSkill {
  path: string;
}

function toDirectlyInstalledSkills(
  response: SkillsListResponse,
  cwd: string,
): DirectlyInstalledSkill[] {
  if (!Array.isArray(response.data)) {
    throw new Error("Codex 响应缺少有效 skills data");
  }
  return response.data.flatMap((entry) => {
    if (entry.cwd !== cwd) {
      return [];
    }
    if (!Array.isArray(entry.skills)) {
      throw new Error("Codex 响应缺少有效 skills entry");
    }
    return entry.skills.flatMap((skill) => {
      if (typeof skill.enabled !== "boolean") {
        throw new Error("Codex 响应缺少有效 skill enabled");
      }
      if (typeof skill.scope !== "string") {
        throw new Error("Codex 响应缺少有效 skill scope");
      }
      if (typeof skill.path !== "string") {
        throw new Error("Codex 响应缺少有效 skill path");
      }
      const normalizedPath = skill.path.replaceAll("\\", "/");
      const directlyInstalled = skill.enabled
        && (skill.scope === "user" || skill.scope === "repo")
        && !normalizedPath.includes("/.codex/plugins/");
      if (!directlyInstalled) {
        return [];
      }
      if (typeof skill.name !== "string" || skill.name.length === 0) {
        throw new Error("Codex 响应缺少有效 skill name");
      }
      if (typeof skill.description !== "string") {
        throw new Error("Codex 响应缺少有效 skill description");
      }
      return [{
        name: skill.name,
        description: skill.description,
        path: skill.path,
      }];
    });
  });
}
