export interface InstalledSkill {
  name: string;
  description: string;
}

export interface SkillQueryPort {
  listSkills(cwd: string): Promise<InstalledSkill[]>;
}
