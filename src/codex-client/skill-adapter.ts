import type { SkillsListResponse } from "../codex-protocol/index.js";
import type { InstalledSkill } from "../application/index.js";

export function toInstalledSkills(response: SkillsListResponse): InstalledSkill[] {
  if (!Array.isArray(response.data)) {
    throw new Error("Codex 响应缺少有效 skills data");
  }
  return response.data.flatMap((entry) => {
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
      return [{ name: skill.name, description: skill.description }];
    });
  });
}
