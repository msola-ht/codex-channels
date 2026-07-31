export interface InstalledSkill {
  name: string;
  description: string;
}

export interface InvocableSkill {
  name: string;
  path: string;
}

export interface SkillQueryPort {
  listSkills(cwd: string): Promise<InstalledSkill[]>;
  resolveSkill(cwd: string, name: string): Promise<InvocableSkill | undefined>;
}
