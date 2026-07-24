export interface ProjectRulesResult {
  projectRoot: string;
  rulesPath: string;
}

export interface ProjectRulesOptions {
  cwd?: string;
  force?: boolean;
}

export interface ProjectRulesAtRootOptions {
  projectRoot: string;
  force?: boolean;
}

export interface ProjectRulesCheckOptions {
  cwd?: string;
  codexBinary?: string;
}

export interface ProjectRulesCheckAtRootOptions {
  projectRoot: string;
  codexBinary?: string;
}

export class ProjectRulesError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function initializeProjectRules(options?: ProjectRulesOptions): ProjectRulesResult;
export function initializeProjectRulesAtRoot(
  options: ProjectRulesAtRootOptions,
): ProjectRulesResult;
export function checkProjectRules(options?: ProjectRulesCheckOptions): ProjectRulesResult;
export function checkProjectRulesAtRoot(
  options: ProjectRulesCheckAtRootOptions,
): ProjectRulesResult;
