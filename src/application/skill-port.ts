export interface InstalledSkill {
  name: string;
  description: string;
}

export interface InvocableSkill {
  name: string;
  path: string;
}

export interface SkillQueryPort {
  listSkills(cwd: string, beforeSubmit?: () => void): Promise<InstalledSkill[]>;
  resolveSkill(cwd: string, name: string, beforeSubmit?: () => void): Promise<InvocableSkill | undefined>;
}
