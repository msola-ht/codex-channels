import { UserFacingError } from "../conversation-core/index.js";

export interface ParsedSlashCommand {
  name: string;
  argumentsText: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const normalized = text.trim();
  if (!normalized.startsWith("/")) {
    return null;
  }
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/u.exec(normalized);
  if (match === null) {
    throw new UserFacingError(
      "command.unsupported",
      "命令格式不受支持",
    );
  }
  return {
    name: match[1]!,
    argumentsText: match[2] ?? "",
  };
}
