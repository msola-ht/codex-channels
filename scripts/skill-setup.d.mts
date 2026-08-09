export interface ProjectSkillEntry {
  name: string;
  path: string;
  installed: boolean;
}

export interface SkillInstallResult {
  name: string;
  installed: boolean;
  target: string;
  reason?: "exists";
}

export interface SkillUninstallResult {
  name: string;
  removed: boolean;
  target: string;
}

export function projectSkillsRoot(projectRoot?: string): string;

export function agentsSkillsDirectory(environment?: NodeJS.ProcessEnv): string;

export function listProjectSkills(options?: {
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
}): ProjectSkillEntry[];

export function listInstalledSkills(options?: {
  environment?: NodeJS.ProcessEnv;
}): string[];

export function installSkill(options?: {
  name: string;
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
  overwrite?: boolean;
}): SkillInstallResult;

export function uninstallSkill(options?: {
  name: string;
  environment?: NodeJS.ProcessEnv;
}): SkillUninstallResult;

export function runSkillSetup(options?: {
  output?: { write(text: string): unknown };
  prompts?: unknown;
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<{ action: "back" }>;
