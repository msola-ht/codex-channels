import { UserFacingError } from "../conversation-core/index.js";

export interface ParsedSlashCommand {
  name: string;
  argumentsText: string;
}

export const surfaceCommandAliases = {
  h: "help",
  skills: "skill",
  work: "workspace",
  r: "resume",
} as const;

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const normalized = text.trim();
  if (!normalized.startsWith("/")) {
    return null;
  }
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/u.exec(normalized);
  if (match === null) {
    throw new UserFacingError(
      "command.unsupported",
      "命令格式不受支持",
    );
  }
  return {
    name: normalizeSurfaceCommandName(match[1]!),
    argumentsText: match[2] ?? "",
  };
}

export function normalizeSurfaceCommandName(name: string): string {
  return surfaceCommandAliases[
    name as keyof typeof surfaceCommandAliases
  ] ?? name;
}
