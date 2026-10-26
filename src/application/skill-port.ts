export interface InstalledSkill {
  name: string;
  description: string;
  /** Current catalog has one safe, directly invocable definition; resolve again before execution. */
  invocable: boolean;
}

export interface InvocableSkill {
  name: string;
  path: string;
}

export interface SkillQueryPort {
  listSkills(cwd: string, beforeSubmit?: () => void): Promise<InstalledSkill[]>;
  resolveSkill(cwd: string, name: string, beforeSubmit?: () => void): Promise<InvocableSkill | undefined>;
}
